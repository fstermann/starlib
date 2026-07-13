"use client";

import Hls from "hls.js";
import {
  AudioWaveform,
  ChevronLeft,
  ChevronRight,
  Pause,
  Play,
  Repeat,
  SkipBack,
  SkipForward,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type WaveSurferType from "wavesurfer.js";

import { BpmPitcher, computePlaybackRate } from "@/components/bpm-pitcher";
import { MixControls } from "@/components/mix-controls";
import { MixOverviewSwipe } from "@/components/mix-overview-swipe";
import { PeaksWaveform } from "@/components/peaks-waveform";
import { PlayerDetailWaveform } from "@/components/player-detail-waveform";
import { PlayerRekordboxWaveform } from "@/components/player-rekordbox-waveform";
import { loadWaveform, pwv4ToPeaks } from "@/components/rekordbox-waveform";
import { api } from "@/lib/api";
import {
  getSharedAudioContext,
  LoopingWebAudioPlayer,
} from "@/lib/looping-web-audio-player";
import {
  clearHandoff,
  createIncomingHtmlDeck,
  createIncomingLocalDeck,
  htmlDeck,
  localDeck,
  runTransition,
  stashHandoff,
  takeHandoff,
  type Deck,
  type TransitionHandle,
} from "@/lib/mix/engine";
import { routeElementThroughGain } from "@/lib/mix/html-deck";
import {
  planTransition,
  type DeckInfo,
  type TransitionPlan,
} from "@/lib/mix/strategies";
import { usePlayer, type PlayerTrack } from "@/lib/player-context";
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
  barSpanSeconds,
  computeCueDisplays,
  keySemitonesForRate,
  semitonesFloatForRate,
  textOn,
  transposeKey,
} from "@/lib/waveform-detail";

/** Zoom steps (bars visible in the detail strip), widest → tightest. */
const ZOOM_LEVELS = [128, 64, 32, 16, 8, 4] as const;
const DEFAULT_ZOOM = 32;
const ZOOM_KEY = "player.zoomBars";
/** Whether the zoomed detail strip is shown (toggled independently of zoom). */
const DETAIL_KEY = "player.detailOpen";

/** Selectable loop lengths, in beats. */
const LOOP_BEAT_STEPS = [1, 2, 4, 8, 16, 32] as const;

/** Phrase-kind → chart token (defined in globals.css). Colours the phrase band
 * drawn over the whole-track overview. */
const SECTION_COLOR_VAR: Record<string, string> = {
  intro: "var(--section-intro)",
  verse: "var(--section-verse)",
  up: "var(--section-up)",
  chorus: "var(--section-chorus)",
  down: "var(--section-down)",
  bridge: "var(--section-bridge)",
  outro: "var(--section-outro)",
  other: "var(--section-other)",
};

/** Step one level toward zoomed-in (`dir=1`) or zoomed-out (`dir=-1`). */
function stepZoom(current: number, dir: 1 | -1): number {
  const i = ZOOM_LEVELS.indexOf(current as (typeof ZOOM_LEVELS)[number]);
  const base = i < 0 ? ZOOM_LEVELS.indexOf(DEFAULT_ZOOM) : i;
  const next = Math.max(0, Math.min(ZOOM_LEVELS.length - 1, base + dir));
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

/** Stable identity for the deck hand-off (matches the main effect's key). */
function handoffKey(track: PlayerTrack): string {
  return track.filePath;
}

/**
 * Create the incoming deck B for `track`: a silent, cued Web Audio player for
 * local tracks or a gain-routed HTML element for SoundCloud. Returns null when
 * a SoundCloud stream URL can't be resolved.
 */
async function prepareDeckB(track: PlayerTrack): Promise<Deck | null> {
  const isSc = selectPeaksSource(track).kind === "soundcloud";
  const resolvedStream =
    track.streamUrl ??
    (track.streamRefreshKey != null
      ? await getCachedSoundcloudStreamUrl(track.streamRefreshKey).catch(
          () => undefined,
        )
      : undefined);
  if (isSc) {
    if (!resolvedStream) return null;
    // Ensure the shared context is running — a pure-SoundCloud session may
    // never have resumed it, and the fade rides its clock.
    getSharedAudioContext()
      .resume()
      .catch(() => {});
    return createIncomingHtmlDeck(resolvedStream);
  }
  const url = resolvedStream ?? api.getAudioUrl(track.filePath);
  return createIncomingLocalDeck(url);
}

/** Best-effort peaks for the crossfade overlay (mirrors the init resolution,
 * lower resolution). Falls back to a flat line on any failure. */
async function resolveTrackPeaks(
  track: PlayerTrack,
  numPeaks: number,
): Promise<number[]> {
  const flat = () => new Array<number>(numPeaks).fill(0.4);
  const src = selectPeaksSource(track);
  try {
    if (src.kind === "rekordbox") {
      const data = await loadWaveform(src.id, src.device);
      if (data) return pwv4ToPeaks(data);
      return src.device ? flat() : api.getFilePeaks(track.filePath, numPeaks);
    }
    if (src.kind === "soundcloud") {
      if (!src.waveformUrl) return flat();
      const p = await getCachedSoundcloudPeaks(src.waveformUrl, numPeaks);
      return p ?? flat();
    }
    return await api.getFilePeaks(track.filePath, numPeaks);
  } catch {
    return flat();
  }
}

/** Build the strategy's DeckInfo from a track's BPM + rekordbox analysis. */
function toDeckInfo(
  bpm: number | null,
  durationSec: number,
  analysis: TrackAnalysis | null,
): DeckInfo {
  return {
    bpm,
    durationSec,
    analysis: analysis
      ? {
          beats: analysis.beatgrid.map((b) => ({
            timeSec: b.timeMs / 1000,
            beat: b.beat,
          })),
          sections: (analysis.sections ?? []).map((s) => ({
            startSec: s.startMs / 1000,
            endSec: s.endMs / 1000,
            kind: s.kind,
          })),
        }
      : null,
  };
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
    setPitchEnabled,
    mixConfig,
  } = usePlayer();
  const containerRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WaveSurferType | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // Local tracks play through Web Audio (gapless loop + instant cue); SoundCloud
  // streams stay on the HTMLAudioElement above. Exactly one is live at a time.
  const webAudioRef = useRef<LoopingWebAudioPlayer | null>(null);
  const isPlayingRef = useRef(isPlaying);
  const nextRef = useRef(next);
  const hasNextRef = useRef(hasNext);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [ready, setReady] = useState(false);
  // Auto-mix state: "idle" (no fade), "armed" (deck B prepared, waiting for the
  // mix-out point), "transitioning" (crossfade running).
  const [mixState, setMixState] = useState<"idle" | "armed" | "transitioning">(
    "idle",
  );
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [zoomBars, setZoomBars] = useState<number>(DEFAULT_ZOOM);
  const [detailOpen, setDetailOpen] = useState(false);
  const [analysis, setAnalysis] = useState<TrackAnalysis | null>(null);

  // Cue + loop (in-memory only; reset on track change). The temp cue point is a
  // single settable/recallable marker; the loop is N beats from a start anchor,
  // enforced in the audio driver below.
  const [cueSec, setCueSec] = useState<number | null>(null);
  const [loopActive, setLoopActive] = useState(false);
  const [loopStartSec, setLoopStartSec] = useState(0);
  const [loopBeats, setLoopBeats] = useState(8);
  // Explicit loop end (seconds) when a loop is armed from a rekordbox loop cue;
  // null falls back to the beat-length calc. Cleared by the beat controls.
  const [loopEndOverride, setLoopEndOverride] = useState<number | null>(null);
  const loopRef = useRef<{ start: number; end: number } | null>(null);

  // --- auto-mix refs (read inside the init effect's long-lived closures) ---
  const mixConfigRef = useRef(mixConfig);
  const mixPlanRef = useRef<TransitionPlan | null>(null);
  // Deck B, prepared ahead of the mix-out point. Ownership moves to the
  // hand-off store when the transition starts; nulled here so cleanup doesn't
  // double-destroy it.
  const mixDeckBRef = useRef<Deck | null>(null);
  const transitionHandleRef = useRef<TransitionHandle | null>(null);
  const transitionStartedRef = useRef(false);
  const transitionCompletedRef = useRef(false);
  const startTransitionRef = useRef<(() => void) | null>(null);
  // Peaks for the crossfade overlay: the live deck A and the prepared deck B.
  const currentPeaksRef = useRef<number[] | null>(null);
  const [nextPeaks, setNextPeaks] = useState<number[] | null>(null);
  // Incoming track's analysis, for the phrase band once the swipe fires.
  const [nextAnalysis, setNextAnalysis] = useState<TrackAnalysis | null>(null);
  // Deck B kept readable during the fade (for the incoming playhead); ownership
  // still moves to the hand-off store.
  const transitionDeckBRef = useRef<Deck | null>(null);
  const transitionFadeRef = useRef(1);
  // Re-time context for a running fade: post-swipe clicks reposition deck A and
  // relaunch the fade at a new elapsed point.
  const transitionRetimeRef = useRef<{
    plan: TransitionPlan;
    deckA: Deck;
    relaunch: (elapsedSec: number) => void;
  } | null>(null);
  // `overviewProg` holds each deck's playhead sampled at a low rate (the
  // full-track overview is static — no need to redraw its heavy canvas every
  // audio frame, which was the stutter).
  const [overviewProg, setOverviewProg] = useState({ old: 0, new: 0 });
  // True once the fade passes its midpoint (the swipe fires) — the side rail
  // then shows the incoming track's info.
  const [mixPastMid, setMixPastMid] = useState(false);
  // Bumped when a running fade is cancelled (rescue-seek back into the old
  // track) so the prepare effect re-arms deck B for the next pass.
  const [rearmTick, setRearmTick] = useState(0);

  useEffect(() => {
    mixConfigRef.current = mixConfig;
  }, [mixConfig]);

  const waveformStyle = useWaveformStyle();

  // Hydrate the persisted zoom level + detail-strip visibility once on mount.
  useEffect(() => {
    getRaw<number>(ZOOM_KEY, DEFAULT_ZOOM)
      .then((v) => {
        if (ZOOM_LEVELS.includes(v as (typeof ZOOM_LEVELS)[number])) {
          setZoomBars(v);
        }
      })
      .catch(() => {});
    getRaw<boolean>(DETAIL_KEY, false)
      .then((v) => setDetailOpen(!!v))
      .catch(() => {});
  }, []);

  const changeZoom = (dir: 1 | -1) => {
    setZoomBars((prev) => {
      const next = stepZoom(prev, dir);
      setRaw(ZOOM_KEY, next).catch(() => {});
      return next;
    });
  };

  const toggleDetail = () => {
    setDetailOpen((prev) => {
      const next = !prev;
      setRaw(DETAIL_KEY, next).catch(() => {});
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

  // --- cue + loop ---
  const loopEndSec = useMemo(() => {
    if (loopEndOverride != null) return loopEndOverride;
    if (!currentBpm || currentBpm <= 0) return null;
    return loopStartSec + (loopBeats * 60) / currentBpm;
  }, [loopEndOverride, currentBpm, loopStartSec, loopBeats]);

  // Drive the loop region. Local tracks loop natively on the Web Audio buffer
  // (sample-accurate, gapless); the ref is the fallback the audioprocess handler
  // reads for the SoundCloud (HTMLAudioElement) path.
  useEffect(() => {
    const region =
      loopActive && loopEndSec != null
        ? { start: loopStartSec, end: loopEndSec }
        : null;
    loopRef.current = region;
    webAudioRef.current?.setLoop(region);
  }, [loopActive, loopStartSec, loopEndSec]);

  // Clear cue + loop when the track changes.
  const trackKey = currentTrack?.rekordboxId ?? currentTrack?.filePath;
  useEffect(() => {
    setCueSec(null);
    setLoopActive(false);
    setLoopEndOverride(null);
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
    setLoopEndOverride(null); // beat-length loop from here
    setLoopActive((active) => {
      if (!active) setLoopStartSec(snapToBeat(currentTime));
      return !active;
    });
  };

  const changeLoopBeats = (dir: 1 | -1) => {
    setLoopEndOverride(null); // switch back to a beat-length loop
    setLoopBeats((prev) => {
      const i = LOOP_BEAT_STEPS.indexOf(
        prev as (typeof LOOP_BEAT_STEPS)[number],
      );
      return LOOP_BEAT_STEPS[
        Math.max(0, Math.min(LOOP_BEAT_STEPS.length - 1, i + dir))
      ];
    });
  };

  // Arm the loop from a rekordbox loop cue (explicit in/out points) and jump to
  // its start. A quick seek for a plain cue; an active loop for a loop cue.
  const jumpToCue = (timeSec: number, outSec: number | null) => {
    if (duration <= 0) return;
    if (outSec != null && outSec > timeSec) {
      setLoopStartSec(timeSec);
      setLoopEndOverride(outSec);
      setLoopActive(true);
    }
    seek(timeSec / duration);
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

      // Both playback paths converge on the shared WaveSurfer setup below via
      // these: the resolved peaks, the WaveSurfer + hover modules, the decoded
      // duration, and the playback `media` (a Web Audio buffer player for local
      // tracks, an HTMLAudioElement for SoundCloud streams).
      let media: HTMLAudioElement | LoopingWebAudioPlayer;
      let knownDuration: number;
      let peaks: number[];
      let wsMod: typeof import("wavesurfer.js");
      let hoverMod: typeof import("wavesurfer.js/dist/plugins/hover.esm.js");
      const isLocal = peaksSource.kind !== "soundcloud";

      // Auto-mix hand-off: if the previous track just crossfaded into this one,
      // deck B is already decoded and playing at full gain. Adopt it and build
      // the waveform view around it — no re-decode, no gap.
      const adopted = takeHandoff(handoffKey(currentTrack!));

      if (adopted) {
        try {
          const [p, ws1, hover1] = await Promise.all([
            peaksPromise,
            wsImportPromise,
            hoverImportPromise,
          ]);
          peaks = p;
          wsMod = ws1;
          hoverMod = hover1;
        } catch (err) {
          if (cancelled) return;
          console.error("[player] failed to load peaks for adopted deck:", err);
          adopted.destroy();
          setErrorMsg("Couldn't load the audio file.");
          return;
        }
        if (cancelled || !containerRef.current) {
          adopted.destroy();
          return;
        }
        media = adopted.media;
        knownDuration = adopted.duration;
        if (adopted.kind === "local") {
          const player = adopted.media as LoopingWebAudioPlayer;
          webAudioRef.current = player;
          player.addEventListener("pause", () => {
            if (webAudioRef.current !== player) return;
            if (transitionStartedRef.current) return;
            if (isPlayingRef.current && player.paused) pause();
          });
          registerSeek((ratio) => {
            player.currentTime =
              Math.max(0, Math.min(1, ratio)) * player.duration;
          });
        } else {
          const audio = adopted.media as HTMLAudioElement;
          audioRef.current = audio;
          audio.addEventListener("pause", () => {
            if (audioRef.current !== audio) return;
            if (transitionStartedRef.current) return;
            if (isPlayingRef.current && audio.paused) pause();
          });
          registerSeek((ratio) => {
            audio.currentTime =
              Math.max(0, Math.min(1, ratio)) * audio.duration;
          });
        }
      } else if (isLocal) {
        // Local file → Web Audio: fetch + decode the whole buffer, then play it
        // through a source node. Seeks reschedule the node (no HTMLMediaElement
        // seek stall), so cue points are instant and loops wrap gaplessly.
        const player = new LoopingWebAudioPlayer();
        webAudioRef.current = player;
        media = player;
        // Mirror the HTMLAudioElement's OS-pause sync (headphones unplugged).
        player.addEventListener("pause", () => {
          if (webAudioRef.current !== player) return;
          if (transitionStartedRef.current) return;
          if (isPlayingRef.current && player.paused) pause();
        });
        // USB Rekordbox exports route audio through the device endpoint
        // (`streamUrl`); plain local files fall back to the file-path endpoint.
        const resolvedStreamUrl = await streamUrlPromise;
        if (cancelled) return;
        const sourceUrl =
          resolvedStreamUrl ?? api.getAudioUrl(currentTrack!.filePath);
        try {
          const [p, ws1, hover1] = await Promise.all([
            peaksPromise,
            wsImportPromise,
            hoverImportPromise,
            player.loadBuffer(sourceUrl),
          ]);
          peaks = p;
          wsMod = ws1;
          hoverMod = hover1;
        } catch (err) {
          if (cancelled) return;
          console.error("[player] failed to load local audio:", err);
          setErrorMsg("Couldn't load the audio file.");
          return;
        }
        if (cancelled || !containerRef.current) return;
        if (!isFinite(player.duration) || player.duration <= 0) return;
        knownDuration = player.duration;
        registerSeek((ratio) => {
          player.currentTime =
            Math.max(0, Math.min(1, ratio)) * player.duration;
        });
      } else {
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
          if (transitionStartedRef.current) return;
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

        hls = attachAudioSource(audio, sourceUrl, {
          onExpired: onStreamExpired,
        });

        // Seeks only need the media element + a finite duration — register as
        // soon as metadata lands instead of waiting for `ws.ready` (which
        // blocks on the peaks fetch). Pending seeks (play-from-position via a
        // row waveform click) apply the moment this registers.
        const registerAudioSeek = () => {
          if (cancelled) return;
          registerSeek((ratio) => {
            audio.currentTime =
              Math.max(0, Math.min(1, ratio)) * audio.duration;
          });
        };

        // Now await the remaining work in parallel: peaks, waveform module
        // imports, and a finite audio.duration. Audio playback has already
        // been kicked off via the `canplay` listener, so this path only
        // affects when the waveform appears — not when sound starts.
        const [scPeaks, scWsMod, scHoverMod] = await Promise.all([
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
        peaks = scPeaks;
        wsMod = scWsMod;
        hoverMod = scHoverMod;
        knownDuration = audio.duration;
        media = audio;
      }

      // Cache deck A's peaks for the crossfade overlay's out-going waveform.
      currentPeaksRef.current = peaks;

      const WaveSurfer = wsMod.default;
      const HoverPlugin = hoverMod.default;

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
        // WaveSurfer types `media` as HTMLMediaElement; it also accepts its own
        // WebAudioPlayer (which LoopingWebAudioPlayer extends) as documented.
        media: media as HTMLMediaElement,
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

      // Apply any loop that was toggled on before this player was wired up.
      if (isLocal) webAudioRef.current?.setLoop(loopRef.current);

      ws.on("ready", () => {
        if (cancelled) return;
        setDuration(knownDuration);
        reportDuration(knownDuration);
        setReady(true);
        registerSeek((ratio) => {
          media.currentTime = Math.max(0, Math.min(1, ratio)) * media.duration;
        });
        // Web Audio play() resumes the AudioContext, which can reject if the
        // track was torn down between ready and this call — swallow it.
        if (isPlayingRef.current) ws!.play().catch(() => {});
      });

      ws.on("audioprocess", () => {
        let t = ws!.getCurrentTime();
        // Local tracks loop natively on the buffer node (already wrapped in
        // `t`). The SoundCloud element path has no loop, but keep the seek-wrap
        // as a guarded fallback.
        const lp = webAudioRef.current ? null : loopRef.current;
        if (lp && t >= lp.end) {
          ws!.setTime(lp.start);
          t = lp.start;
        }
        setCurrentTime(t);
        reportProgress(t / knownDuration);

        // Auto-mix: fire the crossfade once we reach the planned mix-out point.
        if (
          mixConfigRef.current.enabled &&
          !transitionStartedRef.current &&
          mixPlanRef.current &&
          mixDeckBRef.current &&
          t >= mixPlanRef.current.deckAMixOutSec
        ) {
          startTransitionRef.current?.();
        }
      });

      ws.on("finish", () => {
        // A crossfade owns the advance — the out-going deck reaching its end
        // mid-fade must not trigger a second next() (which would abort the fade
        // and restart the incoming deck from 0).
        if (transitionStartedRef.current) return;
        if (hasNextRef.current) {
          nextRef.current();
        } else {
          media.currentTime = 0;
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
      // --- auto-mix teardown ---
      const adopted = transitionCompletedRef.current;
      if (adopted) {
        // Crossfade finished cleanly: deck B lives in the hand-off store for
        // the incoming init to adopt. Just reset the flags.
        transitionStartedRef.current = false;
        transitionCompletedRef.current = false;
        setMixState("idle");
      } else {
        // No transition, or a manual skip mid-fade: abort and discard deck B.
        if (transitionStartedRef.current) transitionHandleRef.current?.cancel();
        transitionStartedRef.current = false;
        if (mixDeckBRef.current) {
          mixDeckBRef.current.destroy();
          mixDeckBRef.current = null;
        }
        clearHandoff();
        setMixState("idle");
      }
      transitionHandleRef.current = null;
      transitionRetimeRef.current = null;
      const adoptedDeck = adopted ? transitionDeckBRef.current : null;
      transitionDeckBRef.current = null;
      mixPlanRef.current = null;
      setNextPeaks(null);
      setNextAnalysis(null);
      registerSeek(null);
      if (adoptedDeck && adoptedDeck.duration > 0) {
        // The adopted deck keeps playing through the rebuild — hold its live
        // position so progress subscribers (zoom strip, overview) don't flash
        // back to zero before the incoming init reports.
        reportProgress(adoptedDeck.currentTime / adoptedDeck.duration);
        reportDuration(adoptedDeck.duration);
      } else {
        reportProgress(0);
        reportDuration(0);
      }
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
      if (webAudioRef.current) {
        // Stops the source node and closes the AudioContext (idempotent).
        webAudioRef.current.destroy();
        webAudioRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTrack?.filePath, reportProgress, registerSeek, reportDuration]);

  // Begin the crossfade: wrap the live deck A, start deck B, run the fade, and
  // advance the queue on completion (the rebuilt player adopts deck B).
  const startTransition = useCallback(() => {
    const plan = mixPlanRef.current;
    const deckB = mixDeckBRef.current;
    if (!plan || !deckB || transitionStartedRef.current) return;

    let deckA: Deck | null = null;
    if (webAudioRef.current) {
      deckA = localDeck(webAudioRef.current);
    } else if (audioRef.current) {
      // Route the out-going SoundCloud element through a gain node so it fades.
      deckA = htmlDeck(
        audioRef.current,
        routeElementThroughGain(audioRef.current, 1),
      );
    }
    if (!deckA) return;

    transitionStartedRef.current = true;
    transitionCompletedRef.current = false;
    // Keep deck B readable for the incoming playhead during the fade, and record
    // the fade length for the swipe's CSS transition.
    transitionDeckBRef.current = deckB;
    transitionFadeRef.current = Math.max(0.05, plan.fadeSeconds);
    setMixState("transitioning");

    // Ownership of deck B moves to the hand-off store for the rebuilt player.
    const nextTrack = peekNext();
    if (nextTrack) stashHandoff(handoffKey(nextTrack), deckB);
    mixDeckBRef.current = null;

    // Deck A may sit past the mix-out point (the user seeked into the fade
    // window): join the fade mid-flight instead of starting it from zero.
    const mediaRate =
      (webAudioRef.current ?? audioRef.current)?.playbackRate || 1;
    const elapsedSec =
      Math.max(0, deckA.currentTime - plan.deckAMixOutSec) / mediaRate;

    const launch = (elapsed: number) =>
      runTransition({
        deckA: deckA!,
        deckB,
        plan,
        elapsedSec: elapsed,
        // Swap the side rail to the incoming track's info at the fade's midpoint
        // (pause-aware — the engine's fade clock freezes with the decks).
        onMidpoint: () => setMixPastMid(true),
        onComplete: () => {
          transitionCompletedRef.current = true;
          // Ramp mode leaves the incoming deck at the target tempo; keep pitch on
          // so the pitch effect holds it there after adoption.
          if (plan.mode === "beatmatch-ramp") setPitchEnabled(true);
          nextRef.current();
        },
      });
    transitionHandleRef.current = launch(elapsedSec);
    // Post-swipe clicks can re-time the running fade to a new elapsed point.
    transitionRetimeRef.current = {
      plan,
      deckA,
      relaunch: (elapsed: number) => {
        transitionHandleRef.current?.cancel();
        transitionHandleRef.current = launch(elapsed);
      },
    };
    // Seed the overview playheads from the decks' actual cue positions (deck B
    // may have been cued mid-window by the elapsed join).
    setOverviewProg({
      old: deckA.currentTime / (deckA.duration || 1),
      new: deckB.duration > 0 ? deckB.currentTime / deckB.duration : 0,
    });
  }, [peekNext, setPitchEnabled]);

  useEffect(() => {
    startTransitionRef.current = startTransition;
  }, [startTransition]);

  // Reset the side-rail swap once the fade ends (the engine's midpoint
  // callback sets it).
  useEffect(() => {
    if (mixState !== "transitioning") setMixPastMid(false);
  }, [mixState]);

  // Sample each deck's playhead at ~8 Hz for the (static) overview. Far cheaper
  // than redrawing its full-track canvas on every audio frame.
  useEffect(() => {
    if (mixState !== "transitioning") return;
    const sample = () => {
      const oldMedia = webAudioRef.current ?? audioRef.current;
      const oldD = oldMedia?.duration ?? 0;
      const oldT = oldMedia?.currentTime ?? 0;
      const b = transitionDeckBRef.current;
      setOverviewProg({
        old: oldD > 0 ? Math.min(1, oldT / oldD) : 0,
        new: b && b.duration > 0 ? Math.min(1, b.currentTime / b.duration) : 0,
      });
    };
    sample();
    const id = setInterval(sample, 120);
    return () => clearInterval(id);
  }, [mixState]);

  // Prepare deck B (decode/attach the next track) and compute the transition
  // plan while the current track plays, so the crossfade can start instantly at
  // the mix-out point. Re-runs when the inputs to the plan change.
  useEffect(() => {
    const teardownPrepared = () => {
      if (mixDeckBRef.current) {
        mixDeckBRef.current.destroy();
        mixDeckBRef.current = null;
      }
      mixPlanRef.current = null;
      setNextPeaks(null);
      setNextAnalysis(null);
      if (!transitionStartedRef.current) setMixState("idle");
    };

    if (
      !mixConfig.enabled ||
      !ready ||
      !hasNext ||
      transitionStartedRef.current
    ) {
      teardownPrepared();
      return;
    }
    const nextTrack = peekNext();
    if (!nextTrack) return;

    let cancelled = false;
    (async () => {
      const nextAnalysis = nextTrack.rekordboxId
        ? await getCachedRekordboxAnalysis(
            nextTrack.rekordboxId,
            nextTrack.rekordboxDevice,
          )
        : null;
      if (cancelled) return;

      const deckACurrentRate = computePlaybackRate(
        pitchEnabled,
        currentBpm,
        targetBpm,
      );
      const deckBDesiredRate = computePlaybackRate(
        pitchEnabled,
        nextTrack.bpm ?? null,
        targetBpm,
      );
      // Beatmatch-sync requires the pitcher to be active ("bpm mode"); without
      // it, fall back to a simple time fade.
      const effectiveConfig =
        mixConfig.mode === "beatmatch-sync" && !pitchEnabled
          ? { ...mixConfig, mode: "simple" as const }
          : mixConfig;
      const plan = planTransition({
        deckA: toDeckInfo(currentBpm, duration, analysis),
        deckB: toDeckInfo(nextTrack.bpm ?? null, 0, nextAnalysis),
        deckACurrentRate,
        deckADesiredRate: deckACurrentRate,
        deckBDesiredRate,
        targetBpm,
        config: effectiveConfig,
      });

      const [deck, peaksB] = await Promise.all([
        prepareDeckB(nextTrack),
        resolveTrackPeaks(nextTrack, 400),
      ]);
      if (cancelled || !deck) {
        deck?.destroy();
        return;
      }
      mixDeckBRef.current = deck;
      mixPlanRef.current = plan;
      setNextPeaks(peaksB);
      setNextAnalysis(nextAnalysis);
      setMixState("armed");
    })();

    return () => {
      cancelled = true;
      if (!transitionStartedRef.current) teardownPrepared();
    };
  }, [
    mixConfig,
    ready,
    hasNext,
    peekNext,
    currentBpm,
    targetBpm,
    pitchEnabled,
    duration,
    analysis,
    rearmTick,
  ]);

  useEffect(() => {
    const ws = wsRef.current;
    if (!ws || !ready) return;
    // During a crossfade the transport owns BOTH decks: pause/resume the fade
    // itself (decks + gain/rate automation + fade clock) instead of deck A only.
    if (
      mixState === "transitioning" &&
      !transitionCompletedRef.current &&
      transitionHandleRef.current
    ) {
      if (isPlaying) transitionHandleRef.current.resume();
      else transitionHandleRef.current.pause();
      return;
    }
    if (isPlaying) {
      ws.play().catch(() => {});
    } else {
      ws.pause();
    }
  }, [isPlaying, ready, mixState]);

  // Apply BPM-pitcher playback rate. `playbackRate` resets to 1 whenever the
  // audio element's `src` changes, so this effect re-fires after every track
  // load via the `ready` dependency.
  useEffect(() => {
    const media = webAudioRef.current ?? audioRef.current;
    if (!media) return;
    // Couple pitch to rate (vinyl-style). The HTMLAudioElement defaults
    // preservesPitch to true, keeping the original pitch while changing tempo;
    // for a DJ pitcher we want both to shift together. The Web Audio buffer
    // source already couples them, so this only applies to the element path.
    if (media instanceof HTMLAudioElement) media.preservesPitch = false;
    media.playbackRate = computePlaybackRate(
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

  // Hot cues get a colour + letter; memory cues a running number. Computed once
  // so the top bar, overview markers and detail strip stay consistent.
  const cueDisplays = analysis ? computeCueDisplays(analysis.cues) : [];
  const cueItems = analysis
    ? analysis.cues.map((cue, i) => ({ cue, display: cueDisplays[i] }))
    : [];
  // Top bar splits hot cues (left, in slot order) from memory cues (right).
  const hotCueItems = cueItems
    .filter((x) => x.display.isHot)
    .sort((a, b) => (a.cue.index ?? 0) - (b.cue.index ?? 0));
  const memCueItems = cueItems.filter((x) => !x.display.isHot);

  const loadingProgress = duration > 0 ? currentTime / duration : 0;

  // --- crossfade overlay state ---
  // Gate on the completion ref too: when the fade completes and the queue
  // advances, there is a seam render where `currentTrack` is already the
  // adopted track but `mixState` hasn't reset yet — without the gate the
  // overlay/split would flash a bogus "next" transition for a frame.
  const isTransitioning =
    mixState === "transitioning" && !transitionCompletedRef.current;
  // During the fade the queue hasn't advanced yet, so the incoming track is the
  // next queue entry.
  const nextTrack = isTransitioning ? peekNext() : null;
  const deckAProgress = duration > 0 ? currentTime / duration : 0;
  const deckBDuration = transitionDeckBRef.current?.duration ?? 0;
  const deckBProgress =
    deckBDuration > 0
      ? Math.min(
          1,
          (transitionDeckBRef.current?.currentTime ?? 0) / deckBDuration,
        )
      : 0;
  const nextTitleText = nextTrack
    ? (nextTrack.title ?? nextTrack.fileName)
    : "";

  // The phrase band tracks what the overview shows: the old track until the
  // swipe, the incoming track from the swipe on (and through the adoption
  // seam, where the queue has advanced but this instance hasn't rebuilt yet).
  const bandNext = isTransitioning
    ? mixPastMid
    : transitionCompletedRef.current;
  const bandSections = bandNext ? nextAnalysis?.sections : analysis?.sections;
  const bandDuration = bandNext ? deckBDuration : duration;

  // Past the fade midpoint the rail shows the incoming track's info (synced
  // with the waveform swipe).
  const railTrack =
    isTransitioning && mixPastMid && nextTrack ? nextTrack : currentTrack;
  const artworkUrl =
    railTrack.artworkUrl ?? api.getArtworkUrl(railTrack.filePath);
  const titleText = railTrack.title ?? railTrack.fileName;
  const artistText = railTrack.artist ?? "";

  // Colour the bottom waveform with Rekordbox's own analysis when the user
  // picked a Rekordbox style and the current track carries one. Non-Rekordbox
  // sources always fall through to the default WaveSurfer render.
  const rekColored =
    !!currentTrack.rekordboxId &&
    (waveformStyle === "rekordbox_rgb" || waveformStyle === "rekordbox_blue");
  const rekVariant = waveformStyle === "rekordbox_blue" ? "blue" : "color";

  // A full-track overview render for the crossfade swipe — Rekordbox-coloured
  // when the style + track allow, else the default peaks bars.
  const renderOverviewTrack = (
    track: PlayerTrack,
    peaks: number[],
    progress: number,
    durationSec: number,
  ) => {
    const colored =
      !!track.rekordboxId &&
      (waveformStyle === "rekordbox_rgb" || waveformStyle === "rekordbox_blue");
    return colored && track.rekordboxId ? (
      <PlayerRekordboxWaveform
        trackId={track.rekordboxId}
        device={track.rekordboxDevice}
        variant={rekVariant}
        durationSec={durationSec}
        progressOverride={progress}
        className="h-full"
      />
    ) : (
      <PeaksWaveform peaks={peaks} progress={progress} className="h-full" />
    );
  };

  // Zoom is available for everything except SoundCloud streams (whose ~1800
  // pre-baked samples can't resolve a few bars).
  const zoomable = selectPeaksSource(currentTrack).kind !== "soundcloud";
  // The detail strip (and the rail's expanded BPM/KEY boxes) show only when the
  // user has toggled it on for a zoomable track.
  const detailShown = zoomable && detailOpen;
  // Key readout: the big label is the pitched key (nearest whole semitone),
  // green while pitching; below it sits the original key + the exact (fractional)
  // semitone shift, since a pitch often lands between two keys.
  const playRate = computePlaybackRate(pitchEnabled, currentBpm, targetBpm);
  const keySemitones = keySemitonesForRate(playRate);
  const semitonesFloat = semitonesFloatForRate(playRate);
  const baseKey = currentTrack.musicalKey ?? null;
  const displayKey = baseKey
    ? keySemitones
      ? transposeKey(baseKey, keySemitones)
      : baseKey
    : null;
  const keyPitched = displayKey != null && displayKey !== baseKey;

  // Each deck's effective rate across the fade (ramp modes average the ramp) —
  // converts the wall-clock fade into each track's own seconds.
  const mixRates = (() => {
    const plan = mixPlanRef.current;
    const ramp = plan?.rateRamp;
    return {
      a: ramp ? (ramp.deckAFrom + ramp.deckATo) / 2 : playRate,
      b: ramp
        ? (ramp.deckBFrom + ramp.deckBTo) / 2
        : (plan?.deckBInitialRate ?? 1),
    };
  })();

  // During a crossfade, where the detail strip's half-height split gives way to
  // full height: left of deck B's mix-in point only the old track is audible
  // (it keeps the full height), right of deck A's audible end only the new one
  // is. Screen fractions of each deck's playhead-centred window.
  const detailSplit = (() => {
    if (!isTransitioning || !nextTrack) return null;
    const plan = mixPlanRef.current;
    const fadeSec = transitionFadeRef.current;
    const mixInSec = plan?.deckBStartOffsetSec ?? 0;
    const mixOutSec = plan?.deckAMixOutSec ?? Math.max(0, duration - fadeSec);
    // The fade is wall-clock; deck A consumes it at its playback rate.
    const oldEndSec = Math.min(duration, mixOutSec + fadeSec * mixRates.a);
    const tA = deckAProgress * duration;
    const tB = deckBProgress * deckBDuration;
    // Over the fade's last stretch, sweep both boundaries to the left edge so
    // the incoming track unfolds to full height *before* the split settles at
    // adoption — otherwise the old track's remnant snaps away in one frame.
    const sweepSec = Math.max(0.2, Math.min(1.5, (fadeSec * playRate) / 3));
    const sweep = Math.min(1, Math.max(0, (oldEndSec - tA) / sweepSec));
    const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
    const inX =
      clamp01(
        (0.5 +
          (mixInSec - tB) / barSpanSeconds(zoomBars, nextTrack.bpm ?? null)) *
          sweep,
      ) * 100;
    const outX = Math.max(
      clamp01(
        (0.5 + (oldEndSec - tA) / barSpanSeconds(zoomBars, currentBpm)) * sweep,
      ) * 100,
      inX,
    );
    return {
      // Old: full height until the new track is in, bottom half across the
      // overlap, clipped away once its own audible content ends.
      oldClip: `polygon(0 0, ${inX}% 0, ${inX}% 50%, ${outX}% 50%, ${outX}% 100%, 0 100%)`,
      // New: hidden before its mix-in, top half across the overlap, full
      // height once the old track has run out.
      newClip: `polygon(${inX}% 0, 100% 0, 100% 100%, ${outX}% 100%, ${outX}% 50%, ${inX}% 50%)`,
      // The overlap's screen extent, for the half-split divider line.
      inX,
      outX,
    };
  })();

  // Abort a running fade and jump the old track to `sec`: restore deck A to
  // full gain (and its pitched rate — ramp mode automates it away), discard
  // deck B, and re-arm so the mix fires again on the next pass over the
  // mix-out point.
  const cancelTransitionAndSeek = (sec: number) => {
    transitionHandleRef.current?.cancel();
    transitionHandleRef.current = null;
    transitionRetimeRef.current = null;
    transitionStartedRef.current = false;
    transitionCompletedRef.current = false;
    transitionDeckBRef.current = null;
    // Deck B's ownership moved to the hand-off store at fade start.
    clearHandoff();
    setMixState("idle");
    setMixPastMid(false);
    const media = webAudioRef.current ?? audioRef.current;
    if (media) media.playbackRate = playRate;
    if (duration > 0) seek(Math.max(0, Math.min(1, sec / duration)));
    setRearmTick((t) => t + 1);
  };

  // Click-to-seek on the crossfade overview. Before the swipe the view is the
  // old track at its natural scale: a click is a rescue — abort the fade and
  // jump there. After the swipe the view is the incoming track at true scale:
  // inside the fade window the whole fade is re-timed to the clicked moment
  // (deck A repositioned to match); outside it the old track has no business
  // playing on, so the fade finishes immediately and deck B cues there.
  const handleTransitionSeek = (frac: number) => {
    if (!mixPastMid) {
      cancelTransitionAndSeek(frac * duration);
      return;
    }
    const b = transitionDeckBRef.current;
    if (!b || b.duration <= 0) return;
    const tB = frac * b.duration;
    const rt = transitionRetimeRef.current;
    if (!rt) {
      b.setCurrentTime(tB);
      return;
    }
    const fadeSec = transitionFadeRef.current;
    const startOff = rt.plan.deckBStartOffsetSec;
    const elapsed = (tB - startOff) / mixRates.b; // wall-clock into the fade
    if (elapsed < 0 || elapsed >= fadeSec) {
      b.setCurrentTime(tB);
      transitionHandleRef.current?.finish();
    } else {
      rt.deckA.setCurrentTime(rt.plan.deckAMixOutSec + elapsed * mixRates.a);
      setMixPastMid(elapsed >= fadeSec / 2);
      rt.relaunch(elapsed);
      // Relaunching starts both decks — honor a paused transport.
      if (!isPlaying) transitionHandleRef.current?.pause();
    }
  };

  // Fraction of the track visible in the detail strip — drawn as an indicator
  // rectangle over the whole-track overview.
  const viewport =
    detailShown && duration > 0
      ? (() => {
          const half = barSpanSeconds(zoomBars, currentBpm) / 2 / duration;
          const center = currentTime / duration;
          return {
            left: Math.max(0, center - half),
            width: Math.min(1, center + half) - Math.max(0, center - half),
          };
        })()
      : null;

  // Cue chips for the top utility bar. Hot cues sit over the rail column;
  // memory cues + the in-memory cue point align with the waveform's left edge.
  // The Hot/Mem labels always show; the chips appear once the track is loaded.
  const hotCueChips = (
    <>
      <span className="text-2xs text-muted-foreground mr-0.5 shrink-0 tracking-wide uppercase">
        Hot
      </span>
      {duration > 0 &&
        hotCueItems.map(({ cue, display }, i) => {
          const isLoop = display.isLoop;
          return (
            <button
              key={i}
              type="button"
              data-testid="player-hotcue"
              data-cue-type={cue.type}
              onClick={(e) => {
                jumpToCue(
                  cue.timeMs / 1000,
                  cue.outMs != null ? cue.outMs / 1000 : null,
                );
                e.currentTarget.blur();
              }}
              title={
                isLoop
                  ? `Hot cue ${display.label} — loop`
                  : `Hot cue ${display.label} — jump here`
              }
              className="hover:bg-surface-3 flex h-5 shrink-0 cursor-pointer items-center gap-1 rounded pr-1 pl-0.5 transition-colors"
            >
              <span
                className="flex size-4 items-center justify-center rounded-[3px] text-[10px] leading-none font-bold"
                style={{
                  backgroundColor: display.color,
                  color: textOn(display.color),
                }}
              >
                {display.label}
              </span>
              {isLoop && (
                <Repeat className="size-2.5" style={{ color: display.color }} />
              )}
            </button>
          );
        })}
    </>
  );

  const memCueChips = (
    <>
      <span className="text-2xs text-muted-foreground mr-0.5 shrink-0 tracking-wide uppercase">
        Mem
      </span>
      {duration > 0 &&
        memCueItems.map(({ cue, display }, i) => {
          const isLoop = display.isLoop;
          return (
            <button
              key={i}
              type="button"
              data-testid="player-hotcue"
              data-cue-type={cue.type}
              onClick={(e) => {
                jumpToCue(
                  cue.timeMs / 1000,
                  cue.outMs != null ? cue.outMs / 1000 : null,
                );
                e.currentTarget.blur();
              }}
              title={
                isLoop
                  ? `Memory cue ${display.label} — loop`
                  : `Memory cue ${display.label} — jump here`
              }
              className="hover:bg-surface-3 flex h-5 shrink-0 cursor-pointer items-center gap-1 rounded pr-1 pl-0.5 transition-colors"
            >
              <span
                className="flex size-4 items-center justify-center rounded-[3px] text-[10px] leading-none font-bold"
                style={{
                  backgroundColor: display.color,
                  color: textOn(display.color),
                }}
              >
                {display.label}
              </span>
              {isLoop && (
                <Repeat className="size-2.5" style={{ color: display.color }} />
              )}
            </button>
          );
        })}
      {duration > 0 && cueSec != null && (
        <button
          type="button"
          data-testid="player-cue-chip"
          onClick={(e) => {
            seek(cueSec / duration);
            e.currentTarget.blur();
          }}
          title="Cue point — jump here"
          className="flex h-5 shrink-0 cursor-pointer items-center gap-1 rounded px-1.5 text-[10px] font-semibold text-amber-500 uppercase transition-colors hover:bg-amber-500/10"
        >
          Cue
        </button>
      )}
    </>
  );

  // Detail-strip toggle + zoom stepper for the top bar (hidden for SoundCloud
  // streams, which aren't zoomable). The zoom stepper sits to the left of the
  // expander and only appears while the strip is open.
  const zoomControls = zoomable ? (
    <div className="flex items-center gap-0.5">
      {detailOpen && (
        <>
          <button
            type="button"
            onClick={(e) => {
              changeZoom(-1);
              e.currentTarget.blur();
            }}
            disabled={zoomBars === ZOOM_LEVELS[0]}
            className={cn(
              "text-muted-foreground hover:text-foreground hover:bg-surface-3 flex size-5 cursor-pointer items-center justify-center rounded transition-colors",
              zoomBars === ZOOM_LEVELS[0] &&
                "cursor-not-allowed opacity-40 hover:bg-transparent",
            )}
            title="Zoom out"
            aria-label="Zoom out"
          >
            <ZoomOut className="size-3.5" />
          </button>
          <span className="text-muted-foreground w-6 text-center text-[9px] tabular-nums">
            {zoomBars}
          </span>
          <button
            type="button"
            onClick={(e) => {
              changeZoom(1);
              e.currentTarget.blur();
            }}
            disabled={zoomBars === ZOOM_LEVELS[ZOOM_LEVELS.length - 1]}
            className={cn(
              "text-muted-foreground hover:text-foreground hover:bg-surface-3 flex size-5 cursor-pointer items-center justify-center rounded transition-colors",
              zoomBars === ZOOM_LEVELS[ZOOM_LEVELS.length - 1] &&
                "cursor-not-allowed opacity-40 hover:bg-transparent",
            )}
            title="Zoom in"
            aria-label="Zoom in"
          >
            <ZoomIn className="size-3.5" />
          </button>
        </>
      )}
      <button
        type="button"
        data-testid="player-detail-toggle"
        data-active={detailOpen || undefined}
        onClick={(e) => {
          toggleDetail();
          e.currentTarget.blur();
        }}
        className={cn(
          "hover:bg-surface-3 flex size-5 cursor-pointer items-center justify-center rounded transition-colors",
          detailOpen
            ? "text-primary"
            : "text-muted-foreground hover:text-foreground",
        )}
        title={detailOpen ? "Hide zoomed waveform" : "Show zoomed waveform"}
        aria-label={
          detailOpen ? "Hide zoomed waveform" : "Show zoomed waveform"
        }
        aria-pressed={detailOpen}
      >
        <AudioWaveform className="size-3.5" />
      </button>
    </div>
  ) : null;

  return (
    <div
      ref={rootRef}
      data-testid="waveform-player"
      data-mix-state={mixState}
      className="border-border fixed right-0 bottom-0 left-14 z-40 flex flex-col border-t bg-[var(--surface-2)] shadow-[0_-8px_32px_rgba(0,0,0,0.18)]"
    >
      {/* ===== Utility line — spans the whole player. Hot cues sit over the
          rail column; memory cues start at the waveform's left edge; the merged
          loop control stays far right. ===== */}
      <div
        data-testid="player-utility-bar"
        className="border-border flex h-8 shrink-0 items-center border-b"
      >
        {/* Hot cues — over the rail column (matches its 360px width). */}
        <div className="flex w-[360px] shrink-0 items-center gap-1 overflow-hidden px-3">
          {hotCueChips}
        </div>

        {/* Memory cues start where the waveform starts; loop control far right. */}
        <div className="flex flex-1 items-center gap-2 pr-3 pl-2">
          <div className="flex min-w-0 items-center gap-1 overflow-hidden">
            {memCueChips}
          </div>

          {/* Loop control + detail/zoom controls, pinned to the far right. */}
          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            {/* Incoming-track preview — shown only while the crossfade runs. */}
            {isTransitioning && nextTrack && (
              <div
                data-testid="player-next-chip"
                className="border-primary/40 bg-primary/5 text-primary flex h-6 items-center gap-1 rounded-md border pr-1.5 pl-2"
                title={`Next: ${nextTitleText}`}
              >
                <span className="text-2xs text-muted-foreground tracking-wide uppercase">
                  Next
                </span>
                <span className="max-w-32 truncate text-xs font-medium">
                  {nextTitleText}
                </span>
                <ChevronRight className="size-3" />
              </div>
            )}
            {/* Merged loop control: chevrons set the length, the icon+number
                both shows it and toggles the loop. */}
            <div className="flex items-center gap-0.5">
              <button
                type="button"
                onClick={(e) => {
                  changeLoopBeats(-1);
                  e.currentTarget.blur();
                }}
                disabled={loopBeats === LOOP_BEAT_STEPS[0]}
                className={cn(
                  "text-muted-foreground hover:text-foreground hover:bg-surface-3 flex size-5 cursor-pointer items-center justify-center rounded transition-colors",
                  loopBeats === LOOP_BEAT_STEPS[0] &&
                    "cursor-not-allowed opacity-40 hover:bg-transparent",
                )}
                title="Halve loop length"
                aria-label="Halve loop length"
              >
                <ChevronLeft className="size-3.5" />
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
                  "flex h-6 cursor-pointer items-center gap-1 rounded-md border px-2 text-xs font-semibold tabular-nums transition-colors",
                  loopActive
                    ? "border-primary text-primary hover:bg-primary/10"
                    : "border-border text-muted-foreground hover:text-foreground hover:bg-surface-3",
                  !currentBpm &&
                    "cursor-not-allowed opacity-40 hover:bg-transparent",
                )}
                title={currentBpm ? "Toggle loop" : "Loop needs a known BPM"}
                aria-label="Toggle loop"
              >
                <Repeat className="size-3.5" />
                {loopBeats}
              </button>
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
                  "text-muted-foreground hover:text-foreground hover:bg-surface-3 flex size-5 cursor-pointer items-center justify-center rounded transition-colors",
                  loopBeats === LOOP_BEAT_STEPS[LOOP_BEAT_STEPS.length - 1] &&
                    "cursor-not-allowed opacity-40 hover:bg-transparent",
                )}
                title="Double loop length"
                aria-label="Double loop length"
              >
                <ChevronRight className="size-3.5" />
              </button>
            </div>
            {zoomControls && (
              <>
                <div className="bg-border h-4 w-px" />
                {zoomControls}
              </>
            )}
          </div>
        </div>
      </div>

      {/* ===== Body: side rail + waveforms ===== */}
      <div className="flex min-h-0">
        {/* ===== Side rail — transport + readouts; the right side is waveforms
            only. ===== */}
        <div className="border-border flex w-[360px] shrink-0 flex-col justify-end gap-1 border-r px-3 py-1">
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
            <div className="flex min-w-0 flex-1 flex-col">
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
            {/* Elapsed / total time — compact, up by the title. */}
            <div className="shrink-0 text-right leading-none tabular-nums">
              <span className="text-foreground text-xs font-medium">
                {formatTime(currentTime)}
              </span>
              <span className="text-muted-foreground text-2xs">
                {" "}
                / {formatTime(duration)}
              </span>
            </div>
          </div>

          {/* Transport + BPM/KEY readouts (identical in collapsed & expanded). */}
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
                !hasNext &&
                  "cursor-not-allowed opacity-40 hover:bg-transparent",
              )}
              title="Next (→)"
              aria-label="Next track"
            >
              <SkipForward className="size-3.5" />
            </button>

            {/* BPM + KEY on the same level, right-aligned. Labels are never
                tinted; the value carries the pitch colour. */}
            <div className="ml-auto flex items-center gap-1">
              <MixControls />
              <BpmPitcher />
              <div className="flex h-9 flex-col items-center justify-center px-2 leading-none">
                <span className="flex items-baseline gap-1">
                  <span
                    className={cn(
                      "text-xs font-semibold tabular-nums",
                      keyPitched ? "text-primary" : "text-foreground",
                    )}
                  >
                    {displayKey ?? "—"}
                  </span>
                  <span className="text-muted-foreground text-[8px] tracking-wider uppercase">
                    Key
                  </span>
                </span>
                {pitchEnabled && baseKey != null && (
                  <span className="text-2xs mt-0.5 tabular-nums">
                    {/* Original key in gray; the shift carries the pitch colour. */}
                    <span className="text-muted-foreground">{baseKey}</span>{" "}
                    <span
                      className={
                        keyPitched ? "text-primary" : "text-muted-foreground"
                      }
                    >
                      {semitonesFloat > 0 ? "+" : ""}
                      {semitonesFloat.toFixed(1)} st
                    </span>
                  </span>
                )}
              </div>
            </div>
          </div>
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
              {/* Zoom detail strip (shown when toggled on) */}
              {detailShown && (
                <div
                  data-testid="player-detail-strip"
                  data-zoom-bars={zoomBars}
                  className="relative h-20 px-1"
                  onWheel={(e) => {
                    e.preventDefault();
                    changeZoom(e.deltaY < 0 ? 1 : -1);
                  }}
                >
                  {/* The strip renders keyed deck layers so React reconciles
                      them across the fade's seams: during a fade the split is
                      two layers (new track's top half over the old track's
                      bottom half, each scrolling on its own playhead); at
                      adoption the incoming layer is KEPT in place (same key)
                      instead of remounting — a remount flickers (blank canvas
                      until its waveform/size state reload). */}
                  <div
                    data-testid={
                      isTransitioning && nextTrack
                        ? "player-detail-split"
                        : undefined
                    }
                    className="relative h-full"
                  >
                    {(isTransitioning && nextTrack
                      ? [
                          {
                            key:
                              currentTrack.filePath === nextTrack.filePath
                                ? `${currentTrack.filePath}#out`
                                : currentTrack.filePath,
                            clipPath: detailSplit?.oldClip,
                            node: (
                              <PlayerDetailWaveform
                                track={currentTrack}
                                zoomBars={zoomBars}
                                durationSec={duration}
                                bpm={currentBpm}
                                waveformStyle={waveformStyle}
                                progressOverride={deckAProgress}
                              />
                            ),
                          },
                          {
                            key: nextTrack.filePath,
                            clipPath: detailSplit?.newClip,
                            node: (
                              <PlayerDetailWaveform
                                track={nextTrack}
                                zoomBars={zoomBars}
                                durationSec={deckBDuration}
                                bpm={nextTrack.bpm ?? null}
                                waveformStyle={waveformStyle}
                                progressOverride={deckBProgress}
                              />
                            ),
                          },
                        ]
                      : [
                          {
                            key: currentTrack.filePath,
                            clipPath: undefined,
                            node: (
                              <PlayerDetailWaveform
                                track={currentTrack}
                                zoomBars={zoomBars}
                                // Zero through the adoption seam: the stale old
                                // duration would misplace the kept canvas; zero
                                // freezes it on its last fade frame until the
                                // rebuilt player reports real values.
                                durationSec={
                                  transitionCompletedRef.current ? 0 : duration
                                }
                                bpm={currentBpm}
                                waveformStyle={waveformStyle}
                                loop={
                                  loopActive && loopEndSec != null
                                    ? {
                                        startSec: loopStartSec,
                                        endSec: loopEndSec,
                                      }
                                    : null
                                }
                                cueSec={cueSec}
                              />
                            ),
                          },
                        ]
                    ).map((d) => (
                      <div
                        key={d.key}
                        className="absolute inset-0"
                        style={{ clipPath: d.clipPath }}
                      >
                        {d.node}
                      </div>
                    ))}
                    {/* Half-split divider across the overlap: the two decks
                        above/below it are playing separately. Spans only the
                        split region, so it sweeps out with the boundaries. */}
                    {detailSplit && detailSplit.outX > detailSplit.inX && (
                      <div
                        data-testid="player-detail-split-divider"
                        className="bg-primary pointer-events-none absolute top-1/2 h-0.5 -translate-y-1/2"
                        style={{
                          left: `${detailSplit.inX}%`,
                          width: `${detailSplit.outX - detailSplit.inX}%`,
                        }}
                      />
                    )}
                  </div>
                </div>
              )}

              {/* Overview waveform */}
              <div
                className="relative flex h-12 items-center px-1"
                onWheel={
                  detailShown
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
                {/* Playhead + cue markers + loop region + zoom-window indicator
                    over the whole-track overview. Phrase sections are a separate
                    row. */}
                {duration > 0 && (
                  <div className="pointer-events-none absolute inset-x-1 inset-y-0 z-10">
                    {/* Current play position. */}
                    <div
                      data-testid="player-overview-playhead"
                      className="bg-primary absolute inset-y-0 w-0.5 -translate-x-1/2 rounded-full"
                      style={{ left: `${(currentTime / duration) * 100}%` }}
                    />
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
                    {/* Cue markers — hot cues colour-coded (letter), memory cues
                        numbered. Click to seek. */}
                    {duration > 0 &&
                      analysis?.cues.map((c, i) => {
                        const d = cueDisplays[i];
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
                              style={{ backgroundColor: d.color }}
                            />
                            <button
                              type="button"
                              data-testid="player-cue"
                              data-cue-type={c.type}
                              onClick={() =>
                                jumpToCue(
                                  c.timeMs / 1000,
                                  c.outMs != null ? c.outMs / 1000 : null,
                                )
                              }
                              title={
                                d.isHot
                                  ? `Hot cue ${d.label}`
                                  : `Memory cue ${d.label}`
                              }
                              className="pointer-events-auto absolute top-0 flex size-3 -translate-x-1/2 cursor-pointer items-center justify-center rounded-[2px] text-[8px] leading-none font-bold transition-transform hover:scale-110"
                              style={{
                                backgroundColor: d.color,
                                color: textOn(d.color),
                              }}
                            >
                              {d.label}
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
                {/* Crossfade overlay — aligned full-track overview: old on the
                    left, new overlapping its tail on the right (split top/bottom
                    across the overlap), swiping left at the fade's midpoint to
                    reveal the rest of the incoming track. Reverts to the full
                    incoming waveform once the fade ends. */}
                {isTransitioning && nextTrack && (
                  <div
                    data-testid="player-crossfade-overview"
                    data-style={
                      rekColored ? `rekordbox_${rekVariant}` : "default"
                    }
                    className="animate-in fade-in-0 absolute inset-x-1 inset-y-0 z-20 flex cursor-pointer items-center overflow-hidden bg-[var(--surface-2)] duration-300"
                    onClick={(e) => {
                      const rect = e.currentTarget.getBoundingClientRect();
                      handleTransitionSeek(
                        Math.max(
                          0,
                          Math.min(1, (e.clientX - rect.left) / rect.width),
                        ),
                      );
                    }}
                  >
                    {/* The overlay covers the whole row (opaque, hides the base
                        waveform); the swipe itself renders at the same h-8 as
                        the resting overview waveform. */}
                    <div className="h-8 w-full">
                      <MixOverviewSwipe
                        testId="player-overview-swipe"
                        oldProgress={overviewProg.old}
                        newProgress={overviewProg.new}
                        swipeArmed={mixPastMid}
                        oldDurationSec={duration}
                        newDurationSec={deckBDuration}
                        mixOutSec={
                          mixPlanRef.current?.deckAMixOutSec ??
                          Math.max(0, duration - transitionFadeRef.current)
                        }
                        startOffsetSec={
                          mixPlanRef.current?.deckBStartOffsetSec ?? 0
                        }
                        oldFadeSec={transitionFadeRef.current * mixRates.a}
                        newFadeSec={transitionFadeRef.current * mixRates.b}
                        oldContent={renderOverviewTrack(
                          currentTrack,
                          currentPeaksRef.current ?? [],
                          overviewProg.old,
                          duration,
                        )}
                        newContent={renderOverviewTrack(
                          nextTrack,
                          nextPeaks ?? [],
                          overviewProg.new,
                          deckBDuration,
                        )}
                      />
                    </div>
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

              {/* Phrase band — labelled song-structure sections. From the
                  swipe on (and through the adoption seam) the overview shows
                  the incoming track, so the band flips with it. */}
              {bandDuration > 0 && bandSections?.length ? (
                <div className="relative h-3.5 px-1">
                  <div className="absolute inset-x-1 inset-y-0">
                    {bandSections.map((s, i) => {
                      const color =
                        SECTION_COLOR_VAR[s.kind] ?? SECTION_COLOR_VAR.other;
                      return (
                        <div
                          key={i}
                          data-testid="player-section"
                          className="absolute inset-y-0 flex items-center overflow-hidden rounded-[1px] px-1"
                          style={{
                            left: `${(s.startMs / 1000 / bandDuration) * 100}%`,
                            width: `${((s.endMs - s.startMs) / 1000 / bandDuration) * 100}%`,
                            backgroundColor: color,
                            // Darker same-hue border separates adjacent sections.
                            boxShadow: `inset 0 0 0 1px color-mix(in oklch, ${color} 55%, black)`,
                          }}
                        >
                          <span className="truncate text-[8px] leading-none font-semibold tracking-wide text-black/70 uppercase">
                            {s.label}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
