"use client";

import Hls from "hls.js";
import {
  ChevronLeft,
  ChevronRight,
  Pause,
  Play,
  SkipBack,
  SkipForward,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type WaveSurferType from "wavesurfer.js";

import { BpmPitcher, computePlaybackRate } from "@/components/bpm-pitcher";
import { PlayerDetailWaveform } from "@/components/player-detail-waveform";
import { PlayerRekordboxWaveform } from "@/components/player-rekordbox-waveform";
import { loadWaveform, pwv4ToPeaks } from "@/components/rekordbox-waveform";
import { api } from "@/lib/api";
import { usePlayer } from "@/lib/player-context";
import { selectPeaksSource } from "@/lib/player-peaks";
import {
  getCachedRekordboxAnalysis,
  type TrackAnalysis,
} from "@/lib/rekordbox-analysis";
import { markScUnplayable } from "@/lib/sc-unplayable";
import { getRaw, setRaw } from "@/lib/settings";
import {
  getCachedSoundcloudPeaks,
  getCachedSoundcloudStreamUrl,
  invalidateSoundcloudStreamUrl,
} from "@/lib/soundcloud-cache";
import { useWaveformStyle } from "@/lib/use-waveform-style";
import { cn } from "@/lib/utils";
import {
  barBeatLabel,
  barSpanSeconds,
  buildDownbeatPrefix,
  hotCueLetter,
  textOn,
} from "@/lib/waveform-detail";

/** Zoom steps: `null` = whole-track overview only, then bars visible. */
const ZOOM_LEVELS: (number | null)[] = [null, 128, 64, 32, 16, 8, 4];
const ZOOM_KEY = "player.zoomBars";

/** Selectable loop lengths, in beats. */
const LOOP_BEAT_STEPS = [1, 2, 4, 8, 16, 32] as const;

/** Phrase-kind → chart token (defined in globals.css). Colours the phrase band
 * drawn over the whole-track overview. */
const SECTION_COLOR_VAR: Record<string, string> = {
  intro: "var(--chart-1)",
  down: "var(--chart-1)",
  verse: "var(--chart-2)",
  chorus: "var(--chart-3)",
  up: "var(--chart-3)",
  bridge: "var(--chart-4)",
  outro: "var(--chart-5)",
  other: "var(--border-strong)",
};

/** Step one level toward zoomed-in (`dir=1`) or zoomed-out (`dir=-1`). */
function stepZoom(current: number | null, dir: 1 | -1): number | null {
  const i = ZOOM_LEVELS.indexOf(current);
  const next = Math.max(0, Math.min(ZOOM_LEVELS.length - 1, i + dir));
  return ZOOM_LEVELS[next];
}

/** Heuristic: URL is an HLS playlist (by extension). */
function isHlsUrl(url: string): boolean {
  const noQuery = url.split("?")[0] ?? url;
  return noQuery.endsWith(".m3u8");
}

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
    toggle,
    pause,
    next,
    previous,
    peekNext,
    hasNext,
    hasPrevious,
    reportProgress,
    registerSeek,
    reportDuration,
    seek,
    currentBpm,
    targetBpm,
    pitchEnabled,
  } = usePlayer();
  const containerRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WaveSurferType | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const isPlayingRef = useRef(isPlaying);
  const nextRef = useRef(next);
  const hasNextRef = useRef(hasNext);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [ready, setReady] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [zoomBars, setZoomBars] = useState<number | null>(null);
  const [analysis, setAnalysis] = useState<TrackAnalysis | null>(null);

  // Cue + loop (in-memory only; reset on track change). The temp cue point is a
  // single settable/recallable marker; the loop is N beats from a start anchor,
  // enforced in the audio driver below.
  const [cueSec, setCueSec] = useState<number | null>(null);
  const [loopActive, setLoopActive] = useState(false);
  const [loopStartSec, setLoopStartSec] = useState(0);
  const [loopBeats, setLoopBeats] = useState(8);
  const loopRef = useRef<{ start: number; end: number } | null>(null);

  const waveformStyle = useWaveformStyle();

  // Hydrate the persisted zoom level once on mount.
  useEffect(() => {
    getRaw<number | null>(ZOOM_KEY, null)
      .then((v) => {
        if (ZOOM_LEVELS.includes(v)) setZoomBars(v);
      })
      .catch(() => {});
  }, []);

  const changeZoom = (dir: 1 | -1) => {
    setZoomBars((prev) => {
      const next = stepZoom(prev, dir);
      setRaw(ZOOM_KEY, next).catch(() => {});
      return next;
    });
  };

  // Fetch beatgrid/sections/cues for rekordbox tracks (cached; the detail strip
  // shares this fetch). Drives the bar.beat readout.
  const rekId = currentTrack?.rekordboxId;
  const rekDevice = currentTrack?.rekordboxDevice;
  useEffect(() => {
    setAnalysis(null);
    if (!rekId) return;
    let cancelled = false;
    getCachedRekordboxAnalysis(rekId, rekDevice).then((a) => {
      if (!cancelled) setAnalysis(a);
    });
    return () => {
      cancelled = true;
    };
  }, [rekId, rekDevice]);

  const downbeatPrefix = useMemo(
    () => buildDownbeatPrefix(analysis?.beatgrid ?? []),
    [analysis],
  );

  // --- cue + loop ---
  const loopEndSec = useMemo(() => {
    if (!currentBpm || currentBpm <= 0) return null;
    return loopStartSec + (loopBeats * 60) / currentBpm;
  }, [currentBpm, loopStartSec, loopBeats]);

  // Mirror the active loop into a ref the audioprocess handler reads, so it
  // stays live without re-subscribing the WaveSurfer listener on every change.
  useEffect(() => {
    loopRef.current =
      loopActive && loopEndSec != null
        ? { start: loopStartSec, end: loopEndSec }
        : null;
  }, [loopActive, loopStartSec, loopEndSec]);

  // Clear cue + loop when the track changes.
  const trackKey = currentTrack?.rekordboxId ?? currentTrack?.filePath;
  useEffect(() => {
    setCueSec(null);
    setLoopActive(false);
  }, [trackKey]);

  // Snap a time to the nearest beat when a beatgrid is available.
  const snapToBeat = (sec: number): number => {
    const grid = analysis?.beatgrid;
    if (!grid || grid.length === 0) return sec;
    let best = sec;
    let bestDist = Infinity;
    for (const b of grid) {
      const bt = b.timeMs / 1000;
      const d = Math.abs(bt - sec);
      if (d < bestDist) {
        bestDist = d;
        best = bt;
      }
      if (bt > sec + 1) break; // grid is sorted ascending
    }
    return best;
  };

  // Rekordbox-style CUE: playing → tap jumps back to the cue and pauses.
  // Paused → press sets the cue at the playhead and previews (plays while held);
  // release stops and returns to the cue point. A quick tap therefore just sets
  // the cue and leaves playback stopped there.
  const cuePreviewRef = useRef<number | null>(null);
  const handleCueDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    e.currentTarget.setPointerCapture?.(e.pointerId);
    if (duration <= 0) return;
    if (isPlaying) {
      pause();
      seek((cueSec ?? 0) / duration);
    } else {
      const cp = currentTime;
      setCueSec(cp);
      cuePreviewRef.current = cp;
      toggle(); // resume → preview from the cue while held
    }
  };
  const handleCueUp = () => {
    if (cuePreviewRef.current != null && duration > 0) {
      const cp = cuePreviewRef.current;
      cuePreviewRef.current = null;
      pause();
      seek(cp / duration);
    }
  };

  const toggleLoop = () => {
    if (!currentBpm || currentBpm <= 0) return;
    setLoopActive((active) => {
      if (!active) setLoopStartSec(snapToBeat(currentTime));
      return !active;
    });
  };

  const changeLoopBeats = (dir: 1 | -1) => {
    setLoopBeats((prev) => {
      const i = LOOP_BEAT_STEPS.indexOf(
        prev as (typeof LOOP_BEAT_STEPS)[number],
      );
      return LOOP_BEAT_STEPS[
        Math.max(0, Math.min(LOOP_BEAT_STEPS.length - 1, i + dir))
      ];
    });
  };

  // Publish the player's actual height so the layout shell can reserve exactly
  // that much bottom padding (the height varies with collapsed/expanded state).
  useEffect(() => {
    const el = rootRef.current;
    const root = document.documentElement;
    if (!el) {
      root.style.setProperty("--player-height", "0px");
      return;
    }
    const set = () =>
      root.style.setProperty("--player-height", `${el.offsetHeight}px`);
    set();
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => ro.disconnect();
  }, [currentTrack]);

  useEffect(() => {
    isPlayingRef.current = isPlaying;
  }, [isPlaying]);
  useEffect(() => {
    nextRef.current = next;
    hasNextRef.current = hasNext;
  }, [next, hasNext]);

  // Space toggles play/pause. Ignored when the user is typing.
  useEffect(() => {
    if (!currentTrack) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (
          tag === "INPUT" ||
          tag === "TEXTAREA" ||
          tag === "SELECT" ||
          target.isContentEditable
        ) {
          return;
        }
      }
      if (e.key === " " || e.code === "Space") {
        e.preventDefault();
        toggle();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [currentTrack, toggle]);

  // OS / hardware media keys (play, pause, next track, previous track).
  // Uses the browser's Media Session API — the same mechanism SoundCloud
  // and Spotify use to react to keyboard media keys and Bluetooth remotes.
  useEffect(() => {
    if (typeof navigator === "undefined" || !("mediaSession" in navigator)) {
      return;
    }
    const ms = navigator.mediaSession;
    if (!currentTrack) {
      ms.metadata = null;
      ms.setActionHandler("play", null);
      ms.setActionHandler("pause", null);
      ms.setActionHandler("nexttrack", null);
      ms.setActionHandler("previoustrack", null);
      return;
    }
    const art =
      currentTrack.artworkUrl ?? api.getArtworkUrl(currentTrack.filePath);
    ms.metadata = new MediaMetadata({
      title: currentTrack.title ?? currentTrack.fileName,
      artist: currentTrack.artist ?? "",
      artwork: art
        ? [
            { src: art, sizes: "512x512", type: "image/jpeg" },
            { src: art, sizes: "256x256", type: "image/jpeg" },
          ]
        : undefined,
    });
    ms.playbackState = isPlaying ? "playing" : "paused";
    ms.setActionHandler("play", () => {
      if (!isPlayingRef.current) toggle();
    });
    ms.setActionHandler("pause", () => {
      if (isPlayingRef.current) toggle();
    });
    ms.setActionHandler("nexttrack", hasNext ? () => next() : null);
    ms.setActionHandler("previoustrack", hasPrevious ? () => previous() : null);
    return () => {
      ms.setActionHandler("play", null);
      ms.setActionHandler("pause", null);
      ms.setActionHandler("nexttrack", null);
      ms.setActionHandler("previoustrack", null);
    };
  }, [currentTrack, isPlaying, toggle, next, previous, hasNext, hasPrevious]);

  // Pause when the active audio output device disappears (AirPods disconnect,
  // headphones unplugged). The audio element's own `pause` event isn't
  // reliable here — WKWebView/Safari pauses natively, but Chromium-based
  // engines keep playing through the new default output. `devicechange` plus
  // an audiooutput count drop is the canonical signal in both.
  useEffect(() => {
    if (typeof navigator === "undefined" || !navigator.mediaDevices) return;
    const md = navigator.mediaDevices;
    let prevCount = 0;
    let cancelled = false;
    const countOutputs = async () => {
      const devices = await md.enumerateDevices();
      return devices.filter((d) => d.kind === "audiooutput").length;
    };
    countOutputs().then((n) => {
      if (!cancelled) prevCount = n;
    });
    const onChange = async () => {
      const next = await countOutputs();
      if (next < prevCount && isPlayingRef.current) pause();
      prevCount = next;
    };
    md.addEventListener("devicechange", onChange);
    return () => {
      cancelled = true;
      md.removeEventListener("devicechange", onChange);
    };
  }, [pause]);

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

      const BAR_WIDTH = 2;
      const BAR_GAP = 1;
      // Fetch at max resolution once. WaveSurfer renders the bars for the
      // current container width by sampling from this array — with 2000
      // peaks we easily exceed any realistic bar count (a 3000+ px wide
      // waveform at 2+1 px per bar = ~1000 bars), so resize never leaves
      // gaps between bars.
      const numPeaks = 2000;

      // Kick off all network-bound work in parallel:
      //   - WaveSurfer module imports (cached after first track)
      //   - peaks fetch (backend or SC CDN)
      //   - stream URL resolution (only for SC skeleton queue entries)
      // None of these depend on each other, so running them sequentially
      // wastes latency. The audio element + HLS attach happens as soon as
      // the stream URL is ready, independent of peaks/WaveSurfer.
      const wsImportPromise = import("wavesurfer.js");
      const hoverImportPromise =
        import("wavesurfer.js/dist/plugins/hover.esm.js");
      const peaksSource = selectPeaksSource(currentTrack!);
      const peaksPromise: Promise<number[]> =
        peaksSource.kind === "rekordbox"
          ? // Rekordbox already analyzed this track — its PWV4 preview is a
            // ~2ms fetch vs an ~1s ffmpeg decode for backend peaks.
            loadWaveform(peaksSource.id, peaksSource.device).then((data) =>
              data
                ? pwv4ToPeaks(data)
                : // No PWV4 for this track: local-install tracks resolve to a
                  // real file we can decode; USB tracks live off-root, so fall
                  // back to a flat placeholder rather than a doomed ffmpeg call.
                  peaksSource.device
                  ? new Array<number>(numPeaks).fill(0.5)
                  : api.getFilePeaks(currentTrack!.filePath, numPeaks),
            )
          : peaksSource.kind === "soundcloud"
            ? peaksSource.waveformUrl
              ? getCachedSoundcloudPeaks(
                  peaksSource.waveformUrl,
                  numPeaks,
                ).then((p) => p ?? new Array<number>(numPeaks).fill(0.5))
              : Promise.resolve(new Array<number>(numPeaks).fill(0.5))
            : api.getFilePeaks(currentTrack!.filePath, numPeaks);
      const streamUrlPromise: Promise<string | undefined> = currentTrack!
        .streamUrl
        ? Promise.resolve(currentTrack!.streamUrl)
        : currentTrack!.streamRefreshKey !== undefined &&
            currentTrack!.streamRefreshKey !== null
          ? getCachedSoundcloudStreamUrl(currentTrack!.streamRefreshKey).catch(
              (err) => {
                console.error("Failed to resolve SoundCloud stream URL:", err);
                return undefined;
              },
            )
          : Promise.resolve(undefined);

      const audio = new Audio();
      audio.preload = "auto";
      // Attach to DOM so platform pause events (headphones unplugged, etc.)
      // dispatch reliably and so tests can reach the element.
      audio.hidden = true;
      document.body.appendChild(audio);
      audioRef.current = audio;

      // Sync React state when the OS pauses our audio behind our back —
      // e.g. headphones unplugged or Bluetooth device disconnects. Without
      // this, isPlaying stays true and the UI shows "playing" with no sound.
      // We ignore self-initiated pauses two ways: ws.pause() fires this
      // event, but by then isPlayingRef is already false (the [isPlaying]
      // effect updated it). Track-change cleanup also fires pause(), but by
      // then audioRef has been swapped to the new track's element, so the
      // ref-equality check skips it.
      audio.addEventListener("pause", () => {
        if (audioRef.current !== audio) return;
        if (isPlayingRef.current && audio.paused) pause();
      });

      // Start playback as soon as the browser has enough buffered data.
      // This fires well before WaveSurfer's `ready` (which waits for peaks
      // + a finite duration), cutting the "click-to-first-note" latency.
      const resolvedStreamUrl = await streamUrlPromise;
      if (cancelled) return;
      // For SC tracks the resolve can fail — bail before attaching a bad src.
      // Flag the track unplayable so the queue's auto-skip effect advances
      // past it. Don't set errorMsg here: the JSX swaps the container div
      // out for the error text, and the next track's init() runs synchronously
      // before React re-renders to clear the error — so containerRef.current
      // is null and that init bails too, leaving the waveform unrendered.
      if (
        currentTrack!.streamRefreshKey !== undefined &&
        currentTrack!.streamRefreshKey !== null &&
        !resolvedStreamUrl
      ) {
        const sid =
          typeof currentTrack!.streamRefreshKey === "number"
            ? currentTrack!.streamRefreshKey
            : Number(currentTrack!.streamRefreshKey);
        if (Number.isFinite(sid) && sid > 0) markScUnplayable(sid);
        return;
      }
      const sourceUrl =
        resolvedStreamUrl ?? api.getAudioUrl(currentTrack!.filePath);

      const onStreamExpired = async () => {
        if (retriedStreamRefresh || !currentTrack!.streamRefreshKey) return;
        retriedStreamRefresh = true;
        // Evict the frontend cache AND force the backend to bypass its own
        // cache — without force_refresh the server would hand us the same
        // stale URL that just 403'd.
        invalidateSoundcloudStreamUrl(currentTrack!.streamRefreshKey);
        try {
          const url = await getCachedSoundcloudStreamUrl(
            currentTrack!.streamRefreshKey,
            { forceRefresh: true },
          );
          if (cancelled) return;
          // Confirm the refreshed URL is actually live before swapping it in
          // — otherwise we silently replace a broken source with another
          // broken one and the user just sees a dead player. Range-byte HEAD
          // equivalent works against HLS playlist CDNs that reject bare HEAD.
          try {
            const probe = await fetch(url, {
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
          hls = attachAudioSource(audio, url, {
            onExpired: () => {
              // Fresh URL also 403'd — this isn't expiry, it's SoundCloud
              // refusing to stream the track to our app entirely (label
              // upload, geo-restriction, owner-disabled streaming).
              console.warn(
                "[player] refreshed HLS URL also returned 403; track restricted",
              );
              const sid =
                typeof currentTrack!.streamRefreshKey === "number"
                  ? currentTrack!.streamRefreshKey
                  : Number(currentTrack!.streamRefreshKey);
              if (Number.isFinite(sid) && sid > 0) markScUnplayable(sid);
              // No setErrorMsg: the unplayable flag triggers auto-skip,
              // and showing the error swaps out containerRef before the
              // next track's init() can use it (see initial-bail comment).
            },
          });
        } catch (err) {
          console.warn("[player] failed to refresh HLS stream URL:", err);
          setErrorMsg("Couldn't refresh the stream URL.");
        }
      };

      hls = attachAudioSource(audio, sourceUrl, { onExpired: onStreamExpired });

      // Seeks only need the media element + a finite duration — register as
      // soon as metadata lands instead of waiting for `ws.ready` (which
      // blocks on the peaks fetch). Pending seeks (play-from-position via a
      // row waveform click) apply the moment this registers.
      const registerAudioSeek = () => {
        if (cancelled) return;
        registerSeek((ratio) => {
          audio.currentTime = Math.max(0, Math.min(1, ratio)) * audio.duration;
        });
      };

      // Now await the remaining work in parallel: peaks, waveform module
      // imports, and a finite audio.duration. Audio playback has already
      // been kicked off via the `canplay` listener, so this path only
      // affects when the waveform appears — not when sound starts.
      const [peaks, { default: WaveSurfer }, { default: HoverPlugin }] =
        await Promise.all([
          peaksPromise,
          wsImportPromise,
          hoverImportPromise,
          new Promise<void>((resolve) => {
            if (isFinite(audio.duration) && audio.duration > 0) {
              registerAudioSeek();
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
                registerAudioSeek();
                // Kick off playback as soon as duration is known — earlier
                // than `canplay`, which waits for more buffered data.
                if (!cancelled && isPlayingRef.current) {
                  audio.play().catch(() => {
                    /* Will retry via ws.ready → ws.play(). */
                  });
                }
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
          }),
        ]);
      if (cancelled || !containerRef.current) return;
      if (!isFinite(audio.duration) || audio.duration <= 0) return;
      const knownDuration = audio.duration;

      const isDark = document.documentElement.classList.contains("dark");

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
      /* Brand-color hex literals — inline for canvas-gradient perf. See --brand in globals.css. */
      progressGrad.addColorStop(0, isDark ? "#d0fd5a" : "#bde752");
      progressGrad.addColorStop((h * 0.7) / h, "#a8cd49");
      progressGrad.addColorStop((h * 0.7 + 1) / h, "#ffffff");
      progressGrad.addColorStop((h * 0.7 + 2) / h, "#ffffff");
      progressGrad.addColorStop((h * 0.7 + 3) / h, "#a8cd49");
      progressGrad.addColorStop(1, "#a8cd49");

      ws = WaveSurfer.create({
        container: containerRef.current,
        height: 32,
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
        let t = ws!.getCurrentTime();
        const lp = loopRef.current;
        if (lp && t >= lp.end) {
          ws!.setTime(lp.start);
          t = lp.start;
        }
        setCurrentTime(t);
        reportProgress(t / knownDuration);
      });

      ws.on("finish", () => {
        if (hasNextRef.current) {
          nextRef.current();
        } else {
          audio.currentTime = 0;
          setCurrentTime(0);
          reportProgress(0);
        }
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
        audioRef.current.remove();
        audioRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTrack?.filePath, reportProgress, registerSeek, reportDuration]);

  useEffect(() => {
    const ws = wsRef.current;
    if (!ws || !ready) return;
    if (isPlaying) {
      ws.play();
    } else {
      ws.pause();
    }
  }, [isPlaying, ready]);

  // Apply BPM-pitcher playback rate. `playbackRate` resets to 1 whenever the
  // audio element's `src` changes, so this effect re-fires after every track
  // load via the `ready` dependency.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    // Couple pitch to rate (vinyl-style) — browsers default preservesPitch to
    // true, which keeps the original pitch while changing tempo. For a DJ
    // pitcher we want both to shift together.
    audio.preservesPitch = false;
    audio.playbackRate = computePlaybackRate(
      pitchEnabled,
      currentBpm,
      targetBpm,
    );
  }, [pitchEnabled, currentBpm, targetBpm, ready]);

  // Prefetch the next queued track's stream URL + peaks as soon as the
  // current track is decoded. When the user skips, the caches are already
  // warm and only the HLS manifest + first-segment download remains.
  // Defer until `ready` so we don't fight the current track for bandwidth.
  useEffect(() => {
    if (!ready || !hasNext) return;
    const nextTrack = peekNext();
    if (!nextTrack) return;
    // Match the init() resolution so the prefetched peaks hit the same cache
    // key as the real fetch when the next track starts.
    const numPeaks = 2000;
    if (
      nextTrack.streamRefreshKey !== undefined &&
      nextTrack.streamRefreshKey !== null
    ) {
      getCachedSoundcloudStreamUrl(nextTrack.streamRefreshKey).catch(() => {
        /* Prefetch is best-effort; real init will retry. */
      });
    }
    if (nextTrack.waveformUrl) {
      getCachedSoundcloudPeaks(nextTrack.waveformUrl, numPeaks).catch(() => {
        /* Prefetch is best-effort. */
      });
    } else if (nextTrack.rekordboxId) {
      loadWaveform(nextTrack.rekordboxId, nextTrack.rekordboxDevice).catch(
        () => {
          /* Prefetch is best-effort. */
        },
      );
    } else if (nextTrack.streamRefreshKey == null) {
      // Local file — warm the backend's peaks cache so the next track's
      // ffmpeg decode (~1s) happens now instead of on skip.
      api.getFilePeaks(nextTrack.filePath, numPeaks).catch(() => {
        /* Prefetch is best-effort. */
      });
    }
  }, [ready, hasNext, peekNext, currentTrack?.filePath]);

  if (!currentTrack) return null;

  const artworkUrl =
    currentTrack.artworkUrl ?? api.getArtworkUrl(currentTrack.filePath);
  const titleText = currentTrack.title ?? currentTrack.fileName;
  const artistText = currentTrack.artist ?? "";
  const loadingProgress = duration > 0 ? currentTime / duration : 0;

  // Colour the bottom waveform with Rekordbox's own analysis when the user
  // picked a Rekordbox style and the current track carries one. Non-Rekordbox
  // sources always fall through to the default WaveSurfer render.
  const rekColored =
    !!currentTrack.rekordboxId &&
    (waveformStyle === "rekordbox_rgb" || waveformStyle === "rekordbox_blue");
  const rekVariant = waveformStyle === "rekordbox_blue" ? "blue" : "color";

  // Zoom is available for everything except SoundCloud streams (whose ~1800
  // pre-baked samples can't resolve a few bars).
  const zoomable = selectPeaksSource(currentTrack).kind !== "soundcloud";
  const zoomActive = zoomable && zoomBars != null;
  const barBeat = analysis?.beatgrid.length
    ? barBeatLabel(currentTime, analysis.beatgrid, downbeatPrefix)
    : null;
  // Fraction of the track visible in the detail strip — drawn as an indicator
  // rectangle over the whole-track overview.
  const viewport =
    zoomActive && duration > 0
      ? (() => {
          const half = barSpanSeconds(zoomBars!, currentBpm) / 2 / duration;
          const center = currentTime / duration;
          return {
            left: Math.max(0, center - half),
            width: Math.min(1, center + half) - Math.max(0, center - half),
          };
        })()
      : null;

  const remaining = Math.max(0, duration - currentTime);

  return (
    <div
      ref={rootRef}
      data-testid="waveform-player"
      className="border-border fixed right-0 bottom-0 left-14 z-40 flex border-t bg-[var(--surface-2)] shadow-[0_-8px_32px_rgba(0,0,0,0.18)]"
    >
      {/* ===== Side rail — all controls live here; the right side is waveforms
          only. Rows drop from four (expanded) to two (collapsed). ===== */}
      <div className="border-border flex w-[360px] shrink-0 flex-col justify-center gap-1 border-r px-3 py-1.5">
        {/* Artwork + title / artist */}
        <div className="flex min-w-0 items-center gap-2.5">
          <div
            data-testid="player-artwork"
            className="bg-muted size-9 shrink-0 overflow-hidden rounded-md"
          >
            <img
              src={artworkUrl}
              alt=""
              className="size-full object-cover"
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).style.display = "none";
              }}
            />
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <div className="flex min-w-0 items-center gap-1.5">
              <span
                className="text-primary truncate text-sm font-semibold"
                title={titleText}
              >
                {titleText}
              </span>
              {currentTrack.permalinkUrl && (
                <a
                  href={currentTrack.permalinkUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="shrink-0 opacity-70 transition-opacity hover:opacity-100"
                  title="Open on SoundCloud"
                  aria-label="Open on SoundCloud"
                >
                  <img
                    src="/icons/soundcloud.svg"
                    alt=""
                    className="size-3 dark:invert"
                  />
                </a>
              )}
            </div>
            {artistText && (
              <span
                className="text-muted-foreground truncate text-xs"
                title={artistText}
              >
                {artistText}
              </span>
            )}
          </div>
        </div>

        {/* Transport + time */}
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={(e) => {
              previous();
              e.currentTarget.blur();
            }}
            disabled={!hasPrevious && currentTime <= 3}
            className={cn(
              "text-muted-foreground hover:text-foreground hover:bg-surface-3 flex size-7 cursor-pointer items-center justify-center rounded-full transition-colors",
              !hasPrevious &&
                currentTime <= 3 &&
                "cursor-not-allowed opacity-40 hover:bg-transparent",
            )}
            title="Previous (←)"
            aria-label="Previous track"
          >
            <SkipBack className="size-3.5" />
          </button>
          <button
            type="button"
            data-testid="player-toggle"
            onClick={(e) => {
              toggle();
              // Drop focus so a subsequent Space keypress isn't captured by
              // the button's default activation behavior (which would
              // re-toggle on top of the window-level keyboard handler).
              e.currentTarget.blur();
            }}
            className="bg-primary text-primary-foreground hover:bg-primary-hover active:bg-primary-active flex size-8 cursor-pointer items-center justify-center rounded-full transition-colors"
            title={isPlaying ? "Pause (Space)" : "Play (Space)"}
            aria-label={isPlaying ? "Pause" : "Play"}
          >
            {isPlaying ? (
              <Pause className="size-3.5" />
            ) : (
              <Play className="size-3.5 translate-x-px" />
            )}
          </button>
          {/* CUE — round CDJ-style button: tap sets/recalls, hold previews. */}
          <button
            type="button"
            data-testid="player-cue-btn"
            onPointerDown={handleCueDown}
            onPointerUp={handleCueUp}
            onPointerCancel={handleCueUp}
            className={cn(
              "flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full border text-[10px] font-semibold transition-colors select-none",
              cueSec != null
                ? "border-amber-500 text-amber-500 hover:bg-amber-500/10"
                : "border-border text-muted-foreground hover:text-foreground hover:bg-surface-3",
            )}
            title="Cue — tap to set/recall, hold to preview"
            aria-label="Cue"
          >
            CUE
          </button>
          <button
            type="button"
            onClick={(e) => {
              next();
              e.currentTarget.blur();
            }}
            disabled={!hasNext}
            className={cn(
              "text-muted-foreground hover:text-foreground hover:bg-surface-3 flex size-7 cursor-pointer items-center justify-center rounded-full transition-colors",
              !hasNext && "cursor-not-allowed opacity-40 hover:bg-transparent",
            )}
            title="Next (→)"
            aria-label="Next track"
          >
            <SkipForward className="size-3.5" />
          </button>

          {/* Right of transport: time + remaining (expanded) or the pitcher +
              key · bar.beat inline (collapsed, so the rail stays two rows). */}
          <div className="ml-auto flex items-center gap-2">
            {!zoomActive && <BpmPitcher />}
            <div className="flex flex-col items-end leading-tight tabular-nums">
              <span className="text-sm font-medium">
                <span className="text-foreground">
                  {formatTime(currentTime)}
                </span>
                <span className="text-muted-foreground">
                  {" "}
                  / {formatTime(duration)}
                </span>
              </span>
              {zoomActive ? (
                <span className="text-muted-foreground text-xs">
                  −{formatTime(remaining)} LEFT
                </span>
              ) : (
                <span className="text-muted-foreground flex items-center gap-1 text-xs">
                  <span title="Key">{currentTrack.musicalKey ?? "—"}</span>
                  {barBeat && (
                    <>
                      <span>·</span>
                      <span title="Bar.beat">{barBeat}</span>
                    </>
                  )}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Expanded only: loop row + BPM/KEY boxes. */}
        {zoomActive && (
          <>
            <div className="flex items-center gap-0.5">
              <button
                type="button"
                onClick={(e) => {
                  changeLoopBeats(-1);
                  e.currentTarget.blur();
                }}
                disabled={loopBeats === LOOP_BEAT_STEPS[0]}
                className={cn(
                  "text-muted-foreground hover:text-foreground hover:bg-surface-3 border-border flex size-7 cursor-pointer items-center justify-center rounded-md border transition-colors",
                  loopBeats === LOOP_BEAT_STEPS[0] &&
                    "cursor-not-allowed opacity-40 hover:bg-transparent",
                )}
                title="Halve loop length"
                aria-label="Halve loop length"
              >
                <ChevronLeft className="size-4" />
              </button>
              <span
                className="text-foreground border-border w-9 rounded-md border py-1 text-center text-sm font-medium tabular-nums"
                title="Loop length (beats)"
              >
                {loopBeats}
              </span>
              <button
                type="button"
                onClick={(e) => {
                  changeLoopBeats(1);
                  e.currentTarget.blur();
                }}
                disabled={
                  loopBeats === LOOP_BEAT_STEPS[LOOP_BEAT_STEPS.length - 1]
                }
                className={cn(
                  "text-muted-foreground hover:text-foreground hover:bg-surface-3 border-border flex size-7 cursor-pointer items-center justify-center rounded-md border transition-colors",
                  loopBeats === LOOP_BEAT_STEPS[LOOP_BEAT_STEPS.length - 1] &&
                    "cursor-not-allowed opacity-40 hover:bg-transparent",
                )}
                title="Double loop length"
                aria-label="Double loop length"
              >
                <ChevronRight className="size-4" />
              </button>
              <button
                type="button"
                data-testid="player-loop-btn"
                data-active={loopActive || undefined}
                onClick={(e) => {
                  toggleLoop();
                  e.currentTarget.blur();
                }}
                disabled={!currentBpm}
                className={cn(
                  "ml-auto flex h-7 cursor-pointer items-center rounded-md border px-4 text-xs font-semibold transition-colors",
                  loopActive
                    ? "border-primary text-primary hover:bg-primary/10"
                    : "border-border text-muted-foreground hover:text-foreground hover:bg-surface-3",
                  !currentBpm && "cursor-not-allowed opacity-40",
                )}
                title={currentBpm ? "Toggle loop" : "Loop needs a known BPM"}
                aria-label="Toggle loop"
              >
                LOOP
              </button>
            </div>
            <div className="flex items-stretch gap-2">
              <div className="border-border flex flex-1 items-center rounded-md border px-1">
                <BpmPitcher />
              </div>
              <div className="border-border flex flex-1 items-center gap-1.5 rounded-md border px-3">
                <span className="text-foreground text-sm font-semibold tabular-nums">
                  {currentTrack.musicalKey ?? "—"}
                </span>
                <span className="text-2xs text-muted-foreground tracking-wider uppercase">
                  Key
                </span>
              </div>
            </div>
          </>
        )}
      </div>

      {/* ===== Waveform area — right side, waveforms only ===== */}
      {errorMsg ? (
        <div
          role="alert"
          className="text-destructive flex flex-1 items-center px-4 text-xs"
        >
          {errorMsg}
        </div>
      ) : (
        <div className="flex min-w-0 flex-1">
          <div className="relative flex min-w-0 flex-1 flex-col justify-center gap-1 py-2 pl-2">
            {/* Zoom detail strip (expanded only) */}
            {zoomActive && (
              <div
                data-testid="player-detail-strip"
                data-zoom-bars={zoomBars ?? undefined}
                className="h-20 px-1"
                onWheel={(e) => {
                  e.preventDefault();
                  changeZoom(e.deltaY < 0 ? 1 : -1);
                }}
              >
                <PlayerDetailWaveform
                  track={currentTrack}
                  zoomBars={zoomBars!}
                  durationSec={duration}
                  bpm={currentBpm}
                  waveformStyle={waveformStyle}
                  loop={
                    loopActive && loopEndSec != null
                      ? { startSec: loopStartSec, endSec: loopEndSec }
                      : null
                  }
                  cueSec={cueSec}
                />
              </div>
            )}

            {/* Overview waveform */}
            <div
              className="relative flex h-12 items-center px-1"
              onWheel={
                zoomable
                  ? (e) => {
                      e.preventDefault();
                      changeZoom(e.deltaY < 0 ? 1 : -1);
                    }
                  : undefined
              }
            >
              <div
                ref={containerRef}
                className={cn("min-w-0 flex-1", rekColored && "opacity-0")}
                style={{ cursor: "pointer" }}
              />
              {/* Cue markers + loop region + zoom-window indicator over the
                    whole-track overview. Phrase sections are a separate row. */}
              {(viewport ||
                (duration > 0 &&
                  (analysis?.cues.length || loopActive || cueSec != null))) && (
                <div className="pointer-events-none absolute inset-x-1 inset-y-0 z-10">
                  {/* Loop region (drawn under the cue markers). */}
                  {loopActive && loopEndSec != null && duration > 0 && (
                    <div
                      data-testid="player-loop-region"
                      className="border-primary bg-primary/15 absolute inset-y-0 rounded-sm border"
                      style={{
                        left: `${(loopStartSec / duration) * 100}%`,
                        width: `${((loopEndSec - loopStartSec) / duration) * 100}%`,
                      }}
                    />
                  )}
                  {/* Cue markers — numbered colour squares (rekordbox-style),
                        click to seek. */}
                  {duration > 0 &&
                    analysis?.cues.map((c, i) => {
                      const color =
                        c.color ?? (c.type === "hot" ? "#f97316" : "#f43f5e");
                      return (
                        <div
                          key={i}
                          className="absolute inset-y-0"
                          style={{
                            left: `${(c.timeMs / 1000 / duration) * 100}%`,
                          }}
                        >
                          <div
                            className="absolute inset-y-0 w-px -translate-x-1/2"
                            style={{ backgroundColor: color }}
                          />
                          <button
                            type="button"
                            data-testid="player-cue"
                            data-cue-type={c.type}
                            onClick={() => seek(c.timeMs / 1000 / duration)}
                            title={
                              c.type === "hot"
                                ? `Hot cue ${hotCueLetter(c.index)}`
                                : "Memory cue"
                            }
                            className="pointer-events-auto absolute top-0 flex size-3 -translate-x-1/2 cursor-pointer items-center justify-center rounded-[2px] text-[8px] leading-none font-bold transition-transform hover:scale-110"
                            style={{
                              backgroundColor: color,
                              color: textOn(color),
                            }}
                          >
                            {i + 1}
                          </button>
                        </div>
                      );
                    })}
                  {/* In-memory cue point (amber flag), click to recall. */}
                  {cueSec != null && duration > 0 && (
                    <div
                      className="absolute inset-y-0"
                      style={{ left: `${(cueSec / duration) * 100}%` }}
                    >
                      <div className="absolute inset-y-0 w-px -translate-x-1/2 bg-amber-500" />
                      <button
                        type="button"
                        data-testid="player-cue-point"
                        onClick={() => seek(cueSec / duration)}
                        title="Cue point"
                        aria-label="Cue point"
                        className="pointer-events-auto absolute top-0 block size-0 -translate-x-1/2 cursor-pointer border-t-[7px] border-r-[5px] border-l-[5px] border-t-amber-500 border-r-transparent border-l-transparent"
                      />
                    </div>
                  )}
                  {viewport && (
                    <div
                      className="border-primary/70 bg-primary/15 absolute inset-y-0 rounded-sm border"
                      style={{
                        left: `${viewport.left * 100}%`,
                        width: `${viewport.width * 100}%`,
                      }}
                    />
                  )}
                </div>
              )}
              {/* Rekordbox RGB/Blue overlay — WaveSurfer stays mounted (hidden)
                  to keep driving audio + progress; this canvas paints the
                  coloured waveform and owns seek/hover. */}
              {rekColored && currentTrack.rekordboxId && (
                <div
                  data-testid="player-rekordbox-waveform"
                  data-variant={rekVariant}
                  className="absolute inset-x-1 inset-y-0 flex items-center"
                >
                  <PlayerRekordboxWaveform
                    trackId={currentTrack.rekordboxId}
                    device={currentTrack.rekordboxDevice}
                    variant={rekVariant}
                    durationSec={duration}
                    className="h-8"
                  />
                </div>
              )}
              {/* Loading-state fallback progress — fades out once waveform is ready. */}
              <div
                className={cn(
                  "bg-surface-3 pointer-events-none absolute inset-x-1 bottom-0 h-0.5 overflow-hidden rounded-full transition-opacity duration-200",
                  ready ? "opacity-0" : "opacity-100",
                )}
              >
                <div
                  className="bg-primary h-full"
                  style={{
                    width: `${Math.min(100, loadingProgress * 100)}%`,
                  }}
                />
              </div>
            </div>

            {/* Phrase band — labelled song-structure sections. */}
            {duration > 0 && analysis?.sections?.length ? (
              <div className="relative h-3.5 px-1">
                <div className="absolute inset-x-1 inset-y-0">
                  {analysis.sections.map((s, i) => (
                    <div
                      key={i}
                      data-testid="player-section"
                      className="absolute inset-y-0 flex items-center overflow-hidden rounded-[1px] px-1"
                      style={{
                        left: `${(s.startMs / 1000 / duration) * 100}%`,
                        width: `${((s.endMs - s.startMs) / 1000 / duration) * 100}%`,
                        backgroundColor:
                          SECTION_COLOR_VAR[s.kind] ?? SECTION_COLOR_VAR.other,
                      }}
                    >
                      <span className="truncate text-[8px] leading-none font-semibold tracking-wide text-black/70 uppercase">
                        {s.label}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>

          {/* Zoom controls — hidden for SoundCloud streams. */}
          {zoomable && (
            <div className="flex shrink-0 flex-col items-center justify-center gap-0.5 px-2">
              <button
                type="button"
                onClick={(e) => {
                  changeZoom(1);
                  e.currentTarget.blur();
                }}
                disabled={zoomBars === 4}
                className={cn(
                  "text-muted-foreground hover:text-foreground hover:bg-surface-3 flex size-6 cursor-pointer items-center justify-center rounded transition-colors",
                  zoomBars === 4 &&
                    "cursor-not-allowed opacity-40 hover:bg-transparent",
                )}
                title="Zoom in"
                aria-label="Zoom in"
              >
                <ZoomIn className="size-4" />
              </button>
              <span className="text-muted-foreground text-[9px] tabular-nums">
                {zoomBars == null ? "—" : zoomBars}
              </span>
              <button
                type="button"
                onClick={(e) => {
                  changeZoom(-1);
                  e.currentTarget.blur();
                }}
                disabled={zoomBars == null}
                className={cn(
                  "text-muted-foreground hover:text-foreground hover:bg-surface-3 flex size-6 cursor-pointer items-center justify-center rounded transition-colors",
                  zoomBars == null &&
                    "cursor-not-allowed opacity-40 hover:bg-transparent",
                )}
                title="Zoom out"
                aria-label="Zoom out"
              >
                <ZoomOut className="size-4" />
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
