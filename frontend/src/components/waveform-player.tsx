"use client";

import { AnimatePresence, motion } from "framer-motion";
import Hls from "hls.js";
import { Pause, Play, SkipBack, SkipForward } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type WaveSurferType from "wavesurfer.js";

import { BpmPitcher, computePlaybackRate } from "@/components/bpm-pitcher";
import { api } from "@/lib/api";
import { usePlayer } from "@/lib/player-context";
import { markScUnplayable } from "@/lib/sc-unplayable";
import {
  getCachedSoundcloudPeaks,
  getCachedSoundcloudStreamUrl,
  invalidateSoundcloudStreamUrl,
} from "@/lib/soundcloud-cache";
import { useResizableWidth } from "@/lib/use-resizable";
import { cn } from "@/lib/utils";

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
    currentBpm,
    targetBpm,
    pitchEnabled,
  } = usePlayer();
  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WaveSurferType | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const isPlayingRef = useRef(isPlaying);
  const nextRef = useRef(next);
  const hasNextRef = useRef(hasNext);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [ready, setReady] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  const treeWidth = useResizableWidth("tree-panel-width", 240);

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

      // Skeleton SoundCloud entries from the queue have no `streamUrl` yet —
      // `streamRefreshKey` is the durable marker that this is a SC track.
      const isStream =
        !!currentTrack!.streamUrl ||
        currentTrack!.streamRefreshKey !== undefined;

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
      const peaksPromise: Promise<number[]> = isStream
        ? currentTrack!.waveformUrl
          ? getCachedSoundcloudPeaks(currentTrack!.waveformUrl, numPeaks).then(
              (p) => p ?? new Array<number>(numPeaks).fill(0.5),
            )
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
        const t = ws!.getCurrentTime();
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
    }
  }, [ready, hasNext, peekNext, currentTrack?.filePath]);

  if (!currentTrack) return null;

  const artworkUrl =
    currentTrack.artworkUrl ?? api.getArtworkUrl(currentTrack.filePath);
  // SoundCloud serves artwork at multiple sizes via suffix (`-large` is ~100px,
  // `-t500x500` is 500px). Upgrade for the expanded preview so it doesn't look
  // pixelated at tree-panel width. Non-SC URLs pass through unchanged.
  const largeArtworkUrl = artworkUrl.replace("-large", "-t500x500");
  const titleText = currentTrack.title ?? currentTrack.fileName;
  const artistText = currentTrack.artist ?? "";
  const loadingProgress = duration > 0 ? currentTime / duration : 0;

  const morphTransition = {
    type: "spring" as const,
    stiffness: 380,
    damping: 34,
  };

  return (
    <>
      {/* Background panel — fades in/out behind the morphing artwork + title. */}
      <AnimatePresence>
        {expanded && (
          <motion.div
            key="artwork-panel-bg"
            className="border-border fixed bottom-0 left-14 z-50 border-t bg-[var(--surface-2)]"
            style={{
              // Leave the rightmost pixel uncovered so the tree view's own
              // border-r (which the panel would otherwise paint over) stays
              // visible, giving a continuous vertical separator line.
              width: `${treeWidth - 1}px`,
              height: `${treeWidth + 64}px`,
            }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            onClick={() => setExpanded(false)}
          />
        )}
      </AnimatePresence>

      {/* Big artwork — mounted only when expanded; shares layoutId with the
          small artwork so framer-motion animates the transform between them. */}
      {expanded && (
        <motion.button
          layoutId="player-artwork"
          layoutDependency={expanded}
          type="button"
          data-testid="player-artwork"
          onClick={() => setExpanded(false)}
          className="bg-muted fixed left-14 z-50 cursor-pointer overflow-hidden"
          style={{
            bottom: "4rem",
            width: `${treeWidth - 1}px`,
            height: `${treeWidth - 1}px`,
          }}
          title="Collapse artwork"
          aria-label="Collapse artwork"
          transition={morphTransition}
        >
          <img
            src={largeArtworkUrl}
            alt=""
            className="size-full object-cover"
            onError={(e) => {
              // Fall back to the small artwork URL if the hi-res variant 404s
              // (e.g., non-SC sources where `-large` isn't in the URL).
              const img = e.currentTarget as HTMLImageElement;
              if (img.src !== artworkUrl) {
                img.src = artworkUrl;
              } else {
                img.style.display = "none";
              }
            }}
          />
        </motion.button>
      )}

      {/* Big title row — same layoutId dance as the artwork. */}
      {expanded && (
        <motion.div
          layoutId="player-title"
          layoutDependency={expanded}
          className="fixed bottom-0 left-14 z-50 flex h-16 min-w-0 flex-col justify-center gap-0.5 px-3"
          style={{ width: `${treeWidth - 1}px` }}
          onClick={() => setExpanded(false)}
          transition={morphTransition}
        >
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-xs" title={titleText}>
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
                onClick={(e) => e.stopPropagation()}
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
        </motion.div>
      )}

      <div
        data-testid="waveform-player"
        className="border-border fixed right-0 bottom-0 left-14 z-40 flex h-16 items-stretch border-t bg-[var(--surface-2)] shadow-[0_-8px_32px_rgba(0,0,0,0.18)]"
      >
        {/* Mini block — fixed width matching the tree panel above */}
        <div
          className="border-border flex shrink-0 items-center gap-2 border-r pr-3 pl-2"
          style={{ width: `${treeWidth}px` }}
        >
          {/* Artwork — click expands. When expanded, this unmounts and the
            big artwork (same layoutId) takes over; framer-motion animates
            the transform between the two positions. */}
          {!expanded && (
            <motion.button
              layoutId="player-artwork"
              layoutDependency={expanded}
              type="button"
              data-testid="player-artwork"
              className="bg-muted relative flex size-10 shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-md"
              onClick={() => setExpanded(true)}
              title="Expand artwork"
              aria-label="Expand artwork"
              aria-expanded={false}
              transition={morphTransition}
            >
              <img
                src={artworkUrl}
                alt=""
                className="size-full object-cover"
                onError={(e) => {
                  (e.currentTarget as HTMLImageElement).style.display = "none";
                }}
              />
            </motion.button>
          )}

          {/* Title + artist — morphs into the expanded panel's title row. */}
          {!expanded && (
            <motion.div
              layoutId="player-title"
              layoutDependency={expanded}
              className="flex min-w-0 flex-1 flex-col gap-0.5"
              transition={morphTransition}
            >
              <div className="flex min-w-0 items-center gap-1.5">
                <span className="truncate text-xs" title={titleText}>
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
                <div
                  className="text-muted-foreground truncate text-xs"
                  title={artistText}
                >
                  {artistText}
                </div>
              )}
            </motion.div>
          )}
        </div>

        {/* Transport cluster — lifted out of the tree-width column so the
          title block has room to breathe. */}
        <div className="flex shrink-0 items-center gap-0.5 px-3">
          <button
            type="button"
            onClick={(e) => {
              previous();
              e.currentTarget.blur();
            }}
            disabled={!hasPrevious && currentTime <= 3}
            className={cn(
              "text-muted-foreground hover:text-foreground hover:bg-surface-3 flex size-8 cursor-pointer items-center justify-center rounded-md transition-colors",
              !hasPrevious &&
                currentTime <= 3 &&
                "cursor-not-allowed opacity-40 hover:bg-transparent",
            )}
            title="Previous (←)"
            aria-label="Previous track"
          >
            <SkipBack className="size-4" />
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
            className="bg-primary text-primary-foreground hover:bg-primary-hover active:bg-primary-active flex size-9 cursor-pointer items-center justify-center rounded-full transition-colors"
            title={isPlaying ? "Pause (Space)" : "Play (Space)"}
            aria-label={isPlaying ? "Pause" : "Play"}
          >
            {isPlaying ? (
              <Pause className="size-4" />
            ) : (
              <Play className="size-4 translate-x-px" />
            )}
          </button>
          <button
            type="button"
            onClick={(e) => {
              next();
              e.currentTarget.blur();
            }}
            disabled={!hasNext}
            className={cn(
              "text-muted-foreground hover:text-foreground hover:bg-surface-3 flex size-8 cursor-pointer items-center justify-center rounded-md transition-colors",
              !hasNext && "cursor-not-allowed opacity-40 hover:bg-transparent",
            )}
            title="Next (→)"
            aria-label="Next track"
          >
            <SkipForward className="size-4" />
          </button>
        </div>

        {/* Target-BPM pitcher — displays current BPM and allows pitching
          playback. Sits between transport and waveform. */}
        <BpmPitcher />

        {errorMsg ? (
          <div
            role="alert"
            className="text-destructive flex shrink-0 items-center px-3 text-xs"
          >
            {errorMsg}
          </div>
        ) : (
          <>
            {/* Current time — left of waveform */}
            <div className="text-muted-foreground flex shrink-0 items-center pl-2 text-xs tabular-nums">
              {formatTime(currentTime)}
            </div>

            {/* Waveform (fills remaining width) */}
            <div className="relative flex min-w-0 flex-1 items-center px-3">
              <div
                ref={containerRef}
                className="min-w-0 flex-1"
                style={{ cursor: "pointer" }}
              />
              {/* Loading-state fallback progress — fades out once waveform is ready. */}
              <div
                className={cn(
                  "bg-surface-3 pointer-events-none absolute right-3 bottom-2 left-0 h-0.5 overflow-hidden rounded-full transition-opacity duration-200",
                  ready ? "opacity-0" : "opacity-100",
                )}
              >
                <div
                  className="bg-primary h-full"
                  style={{ width: `${Math.min(100, loadingProgress * 100)}%` }}
                />
              </div>
            </div>

            {/* Total duration — right of waveform */}
            <div className="text-muted-foreground flex shrink-0 items-center pr-4 text-xs tabular-nums">
              {formatTime(duration)}
            </div>
          </>
        )}
      </div>
    </>
  );
}
