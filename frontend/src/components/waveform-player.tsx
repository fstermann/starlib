"use client";

import Hls from "hls.js";
import { useEffect, useRef, useState } from "react";
import type WaveSurferType from "wavesurfer.js";

import { api } from "@/lib/api";
import { usePlayer } from "@/lib/player-context";

/** Heuristic: URL is an HLS playlist (by extension). */
function isHlsUrl(url: string): boolean {
  const noQuery = url.split("?")[0] ?? url;
  return noQuery.endsWith(".m3u8");
}

/** Fetch SoundCloud's pre-rendered waveform JSON (samples in 0..1000) and
 * resample into `n` normalized peaks in 0..1. Returns null on any failure so
 * callers can fall back to a flat placeholder. */
async function fetchSoundcloudPeaks(
  url: string,
  n: number,
): Promise<number[] | null> {
  try {
    // SoundCloud's waveform_url typically points at a PNG
    // (e.g. `https://wave.sndcdn.com/xxx_m.png`). The same path with a
    // `.json` extension returns the sample array we actually want.
    const jsonUrl = url.replace(/\.png(\?|$)/, ".json$1");
    const resp = await fetch(jsonUrl);
    if (!resp.ok) return null;
    const data = (await resp.json()) as { samples?: unknown };
    const samples = data.samples;
    if (!Array.isArray(samples) || samples.length === 0) return null;
    let max = 0;
    for (const v of samples) {
      if (typeof v === "number" && v > max) max = v;
    }
    if (max === 0) return null;
    const out = new Array<number>(n);
    for (let i = 0; i < n; i++) {
      const start = Math.floor((i * samples.length) / n);
      const end = Math.max(
        start + 1,
        Math.floor(((i + 1) * samples.length) / n),
      );
      let peak = 0;
      for (let j = start; j < end && j < samples.length; j++) {
        const v = samples[j];
        if (typeof v === "number" && v > peak) peak = v;
      }
      out[i] = peak / max;
    }
    return out;
  } catch {
    return null;
  }
}

/** Attach a URL to an <audio> element using hls.js when needed. Returns an
 * Hls instance (or null) that the caller must destroy on teardown. */
function attachAudioSource(
  audio: HTMLAudioElement,
  url: string,
  opts: { onExpired?: () => void },
): Hls | null {
  if (!isHlsUrl(url)) {
    audio.src = url;
    return null;
  }
  if (Hls.isSupported()) {
    const hls = new Hls();
    hls.loadSource(url);
    hls.attachMedia(audio);
    hls.on(Hls.Events.ERROR, (_evt, data) => {
      if (!data.fatal) return;
      const status = data.response?.code;
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR && status === 403) {
        opts.onExpired?.();
      }
    });
    return hls;
  }
  if (audio.canPlayType("application/vnd.apple.mpegurl")) {
    // Safari / WKWebView native HLS.
    audio.src = url;
    return null;
  }
  console.warn("HLS playback is not supported in this browser");
  return null;
}

function formatTime(s: number): string {
  if (!isFinite(s) || s < 0) return "0:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

export function WaveformPlayer() {
  const {
    currentTrack,
    isPlaying,
    pause,
    reportProgress,
    registerSeek,
    reportDuration,
    largePlayer,
  } = usePlayer();
  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WaveSurferType | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const isPlayingRef = useRef(isPlaying);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [ready, setReady] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Keep isPlayingRef current for use in async callbacks
  useEffect(() => {
    isPlayingRef.current = isPlaying;
  }, [isPlaying]);

  // Initialize / rebuild WaveSurfer whenever the track changes
  useEffect(() => {
    if (!currentTrack) return;

    let ws: WaveSurferType | null = null;
    let hls: Hls | null = null;
    let cancelled = false;
    let retriedStreamRefresh = false;

    setReady(false);
    setCurrentTime(0);
    setDuration(0);
    setErrorMsg(null);

    async function init() {
      if (!containerRef.current || cancelled) return;

      const { default: WaveSurfer } = await import("wavesurfer.js");
      const { default: HoverPlugin } =
        await import("wavesurfer.js/dist/plugins/hover.esm.js");
      if (cancelled || !containerRef.current) return;

      // Calculate how many peaks fit the container at the chosen bar dimensions.
      const BAR_WIDTH = 2;
      const BAR_GAP = 1;
      const containerWidth = containerRef.current.clientWidth || 800;
      const numPeaks = Math.min(
        2000,
        Math.max(50, Math.ceil(containerWidth / (BAR_WIDTH + BAR_GAP))),
      );

      // For local files we fetch pre-computed peaks from the backend so
      // WaveSurfer doesn't need to decode via AudioContext (which fails in
      // sandboxed WKWebView). For SoundCloud streams we use the track's
      // pre-rendered waveform JSON (`waveform_url` on the track object)
      // when available, falling back to a flat placeholder otherwise.
      const isStream = !!currentTrack!.streamUrl;
      let peaks: number[];
      if (isStream) {
        const scPeaks = currentTrack!.waveformUrl
          ? await fetchSoundcloudPeaks(currentTrack!.waveformUrl, numPeaks)
          : null;
        peaks = scPeaks ?? new Array(numPeaks).fill(0.5);
      } else {
        peaks = await api.getFilePeaks(currentTrack!.filePath, numPeaks);
      }
      if (cancelled || !containerRef.current) return;

      // Use an <audio> element for playback so WaveSurfer uses the native
      // media pipeline instead of Web Audio API. crossOrigin is intentionally
      // omitted: peaks are pre-fetched so no Web Audio decoding is needed, and
      // CORS mode on the <audio> element can cause playback failures in the
      // Tauri WKWebView when the WebKit media assertion (RBS) is unavailable.
      const audio = new Audio();
      audio.preload = "metadata";
      audioRef.current = audio;

      const sourceUrl =
        currentTrack!.streamUrl ?? api.getAudioUrl(currentTrack!.filePath);

      const onStreamExpired = async () => {
        if (retriedStreamRefresh || !currentTrack!.streamRefreshKey) return;
        retriedStreamRefresh = true;
        try {
          const fresh = await api.getSoundcloudStreamUrl(
            currentTrack!.streamRefreshKey,
          );
          if (cancelled) return;
          // Confirm the refreshed URL is actually live before swapping it in
          // — otherwise we silently replace a broken source with another
          // broken one and the user just sees a dead player. Range-byte HEAD
          // equivalent works against HLS playlist CDNs that reject bare HEAD.
          try {
            const probe = await fetch(fresh.url, {
              method: "GET",
              headers: { Range: "bytes=0-0" },
            });
            if (!probe.ok) {
              setErrorMsg(
                `Refreshed stream URL returned ${probe.status}. Playback stopped.`,
              );
              return;
            }
          } catch (probeErr) {
            console.error("Refreshed HLS URL probe failed:", probeErr);
            setErrorMsg(
              "Couldn't reach the refreshed stream URL. Playback stopped.",
            );
            return;
          }
          if (cancelled) return;
          hls?.destroy();
          hls = attachAudioSource(audio, fresh.url, {
            onExpired: () => {
              console.error("HLS stream expired twice — giving up");
              setErrorMsg("Stream expired. Please try again.");
            },
          });
        } catch (err) {
          console.error("Failed to refresh HLS stream URL:", err);
          setErrorMsg("Couldn't refresh the stream URL.");
        }
      };

      hls = attachAudioSource(audio, sourceUrl, { onExpired: onStreamExpired });

      // Wait until audio.duration is a finite positive number before creating
      // WaveSurfer. For AIFF files (served as transcoded WAV), loadedmetadata
      // can fire with duration=Infinity if the browser hasn't read the full
      // RIFF header yet. We also listen to durationchange so we catch the
      // moment the browser settles on a real value.
      await new Promise<void>((resolve) => {
        if (isFinite(audio.duration) && audio.duration > 0) {
          resolve();
          return;
        }
        const cleanup = () => {
          audio.removeEventListener("durationchange", check);
          audio.removeEventListener("loadedmetadata", check);
          audio.removeEventListener("error", onError);
        };
        const check = () => {
          if (isFinite(audio.duration) && audio.duration > 0) {
            cleanup();
            resolve();
          }
        };
        const onError = () => {
          cleanup();
          resolve();
        };
        audio.addEventListener("durationchange", check);
        audio.addEventListener("loadedmetadata", check);
        audio.addEventListener("error", onError, { once: true });
      });
      if (cancelled || !containerRef.current) return;
      // Bail on a hard load error (duration stays NaN).
      if (!isFinite(audio.duration) || audio.duration <= 0) return;
      const knownDuration = audio.duration;

      const isDark = document.documentElement.classList.contains("dark");

      // Build canvas gradients for the SoundCloud-style waveform.
      const tmpCanvas = document.createElement("canvas");
      const tmpCtx = tmpCanvas.getContext("2d")!;
      const h = 128;

      const waveGrad = tmpCtx.createLinearGradient(0, 0, 0, h * 1.35);
      if (isDark) {
        waveGrad.addColorStop(0, "#55566a");
        waveGrad.addColorStop((h * 0.7) / h, "#44455a");
        waveGrad.addColorStop((h * 0.7 + 1) / h, "#8888aa");
        waveGrad.addColorStop((h * 0.7 + 2) / h, "#8888aa");
        waveGrad.addColorStop((h * 0.7 + 3) / h, "#333345");
        waveGrad.addColorStop(1, "#333345");
      } else {
        waveGrad.addColorStop(0, "#aaaaab");
        waveGrad.addColorStop((h * 0.7) / h, "#909091");
        waveGrad.addColorStop((h * 0.7 + 1) / h, "#ffffff");
        waveGrad.addColorStop((h * 0.7 + 2) / h, "#ffffff");
        waveGrad.addColorStop((h * 0.7 + 3) / h, "#bbbbbb");
        waveGrad.addColorStop(1, "#bbbbbb");
      }

      const progressGrad = tmpCtx.createLinearGradient(0, 0, 0, h * 1.35);
      /* Brand-color hex literals — kept inline for canvas-gradient perf. See --brand in globals.css. */
      progressGrad.addColorStop(0, isDark ? "#d0fd5a" : "#bde752");
      progressGrad.addColorStop((h * 0.7) / h, "#a8cd49");
      progressGrad.addColorStop((h * 0.7 + 1) / h, "#ffffff");
      progressGrad.addColorStop((h * 0.7 + 2) / h, "#ffffff");
      progressGrad.addColorStop((h * 0.7 + 3) / h, "#a8cd49");
      progressGrad.addColorStop(1, "#a8cd49");

      ws = WaveSurfer.create({
        container: containerRef.current,
        height: 44,
        barWidth: BAR_WIDTH,
        barGap: BAR_GAP,
        barRadius: 2,
        normalize: true,
        waveColor: waveGrad,
        progressColor: progressGrad,
        cursorWidth: 0,
        interact: true,
        peaks: [peaks],
        duration: knownDuration,
        media: audio,
        plugins: [
          HoverPlugin.create({
            lineColor: isDark ? "rgba(255,255,255,0.35)" : "rgba(0,0,0,0.25)",
            lineWidth: 1,
            labelSize: 9,
            labelColor: isDark
              ? "rgba(184,188,198,0.95)"
              : "rgba(51,51,51,0.9)",
            labelBackground: isDark
              ? "rgba(12,16,25,0.82)"
              : "rgba(255,255,255,0.82)",
            labelPreferLeft: true,
            formatTimeCallback: formatTime,
          }),
        ],
      });

      wsRef.current = ws;

      ws.on("ready", () => {
        if (cancelled) return;
        setDuration(knownDuration);
        reportDuration(knownDuration);
        setReady(true);
        registerSeek((ratio) => {
          audio.currentTime = Math.max(0, Math.min(1, ratio)) * audio.duration;
        });
        if (isPlayingRef.current) ws!.play();
      });

      ws.on("audioprocess", () => {
        const t = ws!.getCurrentTime();
        setCurrentTime(t);
        reportProgress(t / knownDuration);
      });

      ws.on("finish", () => {
        pause();
        audio.currentTime = 0;
        setCurrentTime(0);
        reportProgress(0);
      });

      ws.on("seeking", () => {
        const t = ws!.getCurrentTime();
        setCurrentTime(t);
        reportProgress(t / knownDuration);
      });

      ws.on("error", (err) => {
        if (!cancelled) console.error("WaveSurfer error:", err);
      });
    }

    init();

    return () => {
      cancelled = true;
      registerSeek(null);
      reportProgress(0);
      reportDuration(0);
      ws?.destroy();
      wsRef.current = null;
      hls?.destroy();
      hls = null;
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.src = "";
        audioRef.current = null;
      }
    };
    // Only `currentTrack?.filePath` actually drives this effect; rebuilding
    // WaveSurfer on every other currentTrack field change would thrash.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    currentTrack?.filePath,
    pause,
    reportProgress,
    registerSeek,
    reportDuration,
  ]);

  // Sync isPlaying state to WaveSurfer
  useEffect(() => {
    const ws = wsRef.current;
    if (!ws || !ready) return;
    if (isPlaying) {
      ws.play();
    } else {
      ws.pause();
    }
  }, [isPlaying, ready]);

  if (!currentTrack) return null;

  return (
    <div
      data-testid="waveform-player"
      aria-hidden={!largePlayer}
      className={`bg-card border-border fixed right-0 bottom-0 left-14 z-40 flex h-17 items-center gap-4 border-t px-4 shadow-[0_-8px_32px_rgba(0,0,0,0.18)] transition-[transform,opacity] duration-200 ease-out ${
        largePlayer
          ? "translate-y-0 opacity-100"
          : "pointer-events-none translate-y-full opacity-0"
      } ${!ready ? "opacity-60" : ""}`}
    >
      {/* Waveform canvas — play/pause + track info live in the tree-panel mini player */}
      <div
        ref={containerRef}
        className="min-w-0 flex-1"
        style={{ cursor: "pointer" }}
      />

      {/* Error surface — replaces the time display when stream validation
          fails so users see *something* went wrong instead of a dead player. */}
      {errorMsg ? (
        <span
          role="alert"
          className="text-destructive w-fit shrink-0 truncate text-right text-xs"
        >
          {errorMsg}
        </span>
      ) : (
        <span className="text-muted-foreground w-24 shrink-0 text-right font-mono text-xs tabular-nums">
          {formatTime(currentTime)} / {formatTime(duration)}
        </span>
      )}
    </div>
  );
}
