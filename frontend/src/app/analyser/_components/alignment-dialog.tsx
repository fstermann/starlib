"use client";

import Hls from "hls.js";
import {
  BadgeCheck,
  Check,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Crosshair,
  Headphones,
  Loader2,
  Pause,
  Pencil,
  Play,
  RefreshCw,
  RotateCcw,
  SearchX,
  Sparkles,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Slider } from "@/components/ui/slider";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  autoAlignTrack,
  foldTempoRatio,
  formatTimecode,
  getSetPeaks,
  jobAudioUrl,
  linkSoundcloudTrack,
  originalBpmFromSet,
  pitchSpeedRatio,
  updateTrack,
  type AlignChunk,
  type AutoAlignResult,
  type SetPeaks,
  type TrackTimelineEntry,
} from "@/lib/analyser";
import { api, type TrackBpm } from "@/lib/api";
import { getTrack, type SCTrack } from "@/lib/soundcloud";
import {
  decodedBpm,
  getCachedSoundcloudDecodedPeaks,
  getCachedSoundcloudPeaks,
  getCachedSoundcloudStreamUrl,
  updateCachedSoundcloudBpm,
  type DecodedPeaks,
} from "@/lib/soundcloud-cache";
import { cn } from "@/lib/utils";

import {
  PeakStrip,
  type PeakStripHandle,
  type StripBand,
  type StripMarker,
} from "./peak-strip";

interface AlignmentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  jobId: string;
  track: TrackTimelineEntry;
  /** SoundCloud track id to stream as the original. Falls back to
   *  ``track.soundcloud_id`` when not provided — useful when the user
   *  resolved a SoundCloud match via the row's "find on SoundCloud"
   *  affordance, which doesn't yet PATCH the track row. */
  soundcloudIdOverride?: number | null;
  /** Set duration in seconds, from the already-loaded main waveform.
   *  Passed to the MIX WaveSurfer so it renders from a known duration
   *  instead of waiting on a ``loadedmetadata`` that a second, dialog-
   *  scoped media element doesn't reliably fire. */
  setDurationS?: number | null;
  /** Called after save with the new ``start_s`` so the parent can refresh
   *  the snapshot without waiting for the next SSE event. */
  onSaved?: (newStartS: number) => void;
}

/** Zoom range, in pixels per second of mix time. The user drives this with
 *  the zoom slider; higher = more zoomed in, so drag-nudging resolves finer.
 *  Both strips share the density (1 px = 1/pxPerSec of mix time); the SC
 *  strip scales its internal px-per-original-second by the pitch speed ratio
 *  so a set-second lines up across both — see ``scPxPerSec`` below. */
const MIN_PX_PER_S = 4;
const MAX_PX_PER_S = 240;
const DEFAULT_PX_PER_S = 16;
const ZOOM_STEP = 2;
/** Jog steps (set seconds) for scrubbing both decks together. */
const JOG_STEPS_S = [-30, -5, 5, 30] as const;
/** Mix seconds loaded either side of the track: enough to drag or jog past
 *  the mix-in and mix-out. */
const MIX_MARGIN_S = 90;
/** SoundCloud's own waveform is ~1 sample / 100 ms; used only when the
 *  decoded peaks are unavailable. */
const SC_FALLBACK_PEAKS = 1800;

/** Agreeing chunks as non-overlapping spans, each as unique as the most
 *  unique chunk covering it. Chunks overlap (30 s long, every 5 s), so
 *  tinting each one stacks up to six layers and hides the waveform. */
function agreeingSpans(
  chunks: AlignChunk[],
): { startS: number; endS: number; uniqueness: number }[] {
  const agreeing = chunks.filter((c) => c.agrees);
  const edges = [
    ...new Set(agreeing.flatMap((c) => [c.start_s, c.end_s])),
  ].sort((a, b) => a - b);
  const spans: { startS: number; endS: number; uniqueness: number }[] = [];
  for (let i = 0; i + 1 < edges.length; i++) {
    const [startS, endS] = [edges[i], edges[i + 1]];
    const covering = agreeing.filter(
      (c) => c.start_s <= startS && c.end_s >= endS,
    );
    if (covering.length === 0) continue;
    spans.push({
      startS,
      endS,
      uniqueness: Math.max(...covering.map((c) => c.uniqueness)),
    });
  }
  return spans;
}

// Re-anchor when the extrapolated time drifts this far from the media clock.
const CLOCK_RESYNC_S = 0.3;

/** Media time per animation frame. WebKit advances ``currentTime`` in coarse
 *  steps, so between steps this extrapolates from the last one at the
 *  playback rate. */
function smoothClock() {
  let anchorMedia = NaN;
  let anchorAt = 0;
  return (audio: HTMLMediaElement, now: number): number => {
    const media = audio.currentTime;
    if (audio.paused) return media;
    const guess = anchorMedia + ((now - anchorAt) / 1000) * audio.playbackRate;
    if (!(Math.abs(guess - media) < CLOCK_RESYNC_S)) {
      anchorMedia = media;
      anchorAt = now;
      return media;
    }
    return guess;
  };
}
/** Accepted original-BPM correction range, mirroring the backend's 40–300
 *  guard so an out-of-range value is caught before the request. */
const BPM_MIN = 40;
const BPM_MAX = 300;

/** A/B comparison + manual alignment for a Shazam-identified track.
 *
 *  Renders the cached set audio and the original SoundCloud track as
 *  two stacked canvas waveforms with a shared centre playhead, both
 *  repainted from one animation-frame loop. The
 *  user drags either waveform horizontally (zooming in for finer control)
 *  until kicks line up by eye, then saves. The saved start is computed
 *  from both positions. Transport plays both decks together
 *  (phase-locked, original at ``1 / pitchSpeedRatio(pitch_offset)`` to
 *  match the mix's tempo); a DJ-style cue picks what you hear — the mix
 *  (A), the original (B), or both (master).
 *
 *  On open, the backend matches the original against the mix and the
 *  strips start at its suggestion; saving stays the user's confirmation. */
export function AlignmentDialog({
  open,
  onOpenChange,
  jobId,
  track,
  soundcloudIdOverride,
  setDurationS,
  onSaved,
}: AlignmentDialogProps) {
  const soundcloudId = soundcloudIdOverride ?? track.soundcloud_id ?? null;
  const trackTitle = track.title;
  const trackId = track.id;

  const mixStripRef = useRef<PeakStripHandle | null>(null);
  const origStripRef = useRef<PeakStripHandle | null>(null);
  const setAudioRef = useRef<HTMLAudioElement | null>(null);
  const scAudioRef = useRef<HTMLAudioElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const [mixPeaks, setMixPeaks] = useState<SetPeaks | null>(null);
  const [origPeaks, setOrigPeaks] = useState<number[] | null>(null);

  const [streamUrl, setStreamUrl] = useState<string | null>(null);
  const [streamError, setStreamError] = useState<string | null>(null);
  // The SoundCloud track to align against: the persisted/override id, or
  // one resolved by searching the Shazam title+artist (Shazam rows carry
  // no soundcloud_id). ``null`` after ``scResolving`` clears = genuine miss.
  const [scId, setScId] = useState<number | null>(null);
  // Waveform + duration of the resolved original, taken straight from the
  // resolved track (the same source the working preview waveforms use) —
  // re-fetching via a second getTrack returned no usable waveform data.
  const [scMeta, setScMeta] = useState<{
    waveformUrl: string | null;
    durationS: number;
  } | null>(null);
  const [scResolving, setScResolving] = useState(false);
  const [setReady, setSetReady] = useState(false);
  const [scReady, setScReady] = useState(false);
  // High-res peaks + detected tempo of the original, decoded server-side.
  // ``scDecodedResolved`` distinguishes "still fetching" from "fetched,
  // nothing usable" so the strip build waits for the tempo before rendering
  // (settling the speed ratio) yet still falls back to the coarse
  // waveform_url when the decode endpoint yields nothing.
  const [scDecoded, setScDecoded] = useState<DecodedPeaks | null>(null);
  const [scDecodedResolved, setScDecodedResolved] = useState(false);

  // DJ-style transport + cue. ``transport`` runs both decks together;
  // ``cue`` picks what you monitor (like a headphone cue): the mix (A),
  // the original (B), or both (master). Cue changes are applied live via
  // each element's volume, so switching never restarts playback.
  const [transport, setTransport] = useState(false);
  const [cue, setCue] = useState<"mix" | "original" | "both">("both");
  const isPlaying = transport;
  // Alignment is two independently-draggable positions, both read at the
  // centred playhead: ``mixCenterS`` (mix time) and ``origCenterS``
  // (original time). Saving derives the track's start from them.
  const [mixCenterS, setMixCenterS] = useState(track.start_s);
  const [origCenterS, setOrigCenterS] = useState(0);
  const [saving, setSaving] = useState(false);
  // In/out set by hand at the playhead; otherwise the saved or matched ones.
  const [mixInEdit, setMixInEdit] = useState<number | null>(null);
  const [mixOutEdit, setMixOutEdit] = useState<number | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [autoAlign, setAutoAlign] = useState<
    "running" | AutoAlignResult | null
  >(null);

  // Original-BPM correction. Detection occasionally lands an octave off
  // (half/double time), which throws off the stretch ratio; the user can
  // type the right value or force a re-detect. ``bpmBusy`` guards concurrent
  // requests; the corrected value is written back into ``scDecoded`` so the
  // ratio (and strip scale) update live.
  const [bpmEditing, setBpmEditing] = useState(false);
  const [bpmInput, setBpmInput] = useState("");
  const [bpmBusy, setBpmBusy] = useState(false);
  const [bpmError, setBpmError] = useState<string | null>(null);

  // Zoom (px per set-second). Applied live via ``ws.zoom`` on both strips,
  // so changing it re-renders from existing peaks without re-decoding the
  // mix or re-loading the SC stream. Refs mirror the derived densities so
  // the ``timeupdate`` scroll handlers (created once) read the live zoom.
  const [pxPerSec, setPxPerSec] = useState(DEFAULT_PX_PER_S);

  const setDurationBound =
    setDurationS != null && setDurationS > 0 ? setDurationS : null;
  const origDurationS =
    scDecoded?.durationS != null && scDecoded.durationS > 0
      ? scDecoded.durationS
      : (scMeta?.durationS ?? 0);
  const origDurationBound = origDurationS > 0 ? origDurationS : null;
  const clampMix = useCallback(
    (v: number) => Math.min(Math.max(0, v), setDurationBound ?? v),
    [setDurationBound],
  );
  const clampOrig = useCallback(
    (v: number) => Math.min(Math.max(0, v), origDurationBound ?? v),
    [origDurationBound],
  );

  // Match the original's tempo to the mix. ``speedRatio`` follows the same
  // convention as ``pitchSpeedRatio``: original_bpm ÷ set_bpm (so the element
  // plays at ``1/speedRatio`` to sound at set tempo). Prefer the true BPM
  // ratio — correct whether the DJ used a pitch fader or key-lock — and fall
  // back to the Shazam pitch offset when a BPM is missing.
  const bpmRatio =
    track.set_bpm != null &&
    track.set_bpm > 0 &&
    scDecoded?.bpm != null &&
    scDecoded.bpm > 0
      ? foldTempoRatio(scDecoded.bpm / track.set_bpm)
      : null;
  const speedRatio =
    bpmRatio ??
    (track.pitch_offset != null ? pitchSpeedRatio(track.pitch_offset) : 1);

  // Per-strip BPM readouts. The mix shows the tempo detected in the set (can
  // vary if the DJ rode the fader); the original shows its native tempo plus
  // how much it was sped/slowed in the mix (``1/speedRatio`` = playback rate).
  const mixBpm =
    track.set_bpm != null && track.set_bpm > 0 ? track.set_bpm : null;
  const origBpm =
    scDecoded?.bpm != null && scDecoded.bpm > 0
      ? scDecoded.bpm
      : originalBpmFromSet(track.set_bpm, track.pitch_offset);
  const mixSpeedFactor = 1 / speedRatio;

  const applyDecodedBpm = useCallback(
    (r: TrackBpm) => {
      setScDecoded((prev) => (prev ? { ...prev, ...decodedBpm(r) } : prev));
      if (scId != null) updateCachedSoundcloudBpm(scId, r);
    },
    [scId],
  );

  const saveBpmOverride = useCallback(async () => {
    if (scId == null) return;
    const value = Number(bpmInput);
    if (!Number.isFinite(value) || value < BPM_MIN || value > BPM_MAX) {
      setBpmError(`BPM must be between ${BPM_MIN} and ${BPM_MAX}`);
      return;
    }
    setBpmBusy(true);
    setBpmError(null);
    try {
      const r = await api.setSoundcloudTrackBpm(scId, value);
      applyDecodedBpm(r);
      setBpmEditing(false);
    } catch (err) {
      setBpmError(err instanceof Error ? err.message : String(err));
    } finally {
      setBpmBusy(false);
    }
  }, [scId, bpmInput, applyDecodedBpm]);

  const revertBpm = useCallback(async () => {
    if (scId == null) return;
    setBpmBusy(true);
    setBpmError(null);
    try {
      const r = await api.clearSoundcloudTrackBpm(scId);
      applyDecodedBpm(r);
    } catch (err) {
      setBpmError(err instanceof Error ? err.message : String(err));
    } finally {
      setBpmBusy(false);
    }
  }, [scId, applyDecodedBpm]);

  const reanalyseBpm = useCallback(
    async (strong: boolean) => {
      if (scId == null) return;
      setBpmBusy(true);
      setBpmError(null);
      try {
        const r = await api.reanalyseSoundcloudTrackBpm(scId, strong);
        applyDecodedBpm(r);
      } catch (err) {
        setBpmError(err instanceof Error ? err.message : String(err));
      } finally {
        setBpmBusy(false);
      }
    },
    [scId, applyDecodedBpm],
  );

  // SC plays at ``1/speedRatio`` to match set tempo. Visually we
  // compensate by stretching the SC waveform so 1 px = same set-time
  // as the set strip. Internal px-per-original-second is reduced
  // accordingly.
  const scPxPerSec = pxPerSec * speedRatio;
  // Read by the original deck's mount so a BPM correction doesn't re-run it
  // (and re-buffer the stream).
  const scDecodedRef = useRef(scDecoded);
  scDecodedRef.current = scDecoded;

  // The saved start is where the original's t=0 lands in the mix. At the
  // playhead mix=``mixCenterS`` aligns with original=``origCenterS``, and
  // one original second occupies ``speedRatio`` set seconds, so the
  // original's start sits ``origCenterS * speedRatio`` earlier.
  const newStartS = Math.max(0, mixCenterS - origCenterS * speedRatio);
  const offsetS = newStartS - track.start_s;

  // Reset both positions whenever the dialog opens against a new track.
  useEffect(() => {
    if (open) {
      setMixCenterS(track.start_s);
      setOrigCenterS(0);
      setSaveError(null);
      setMixInEdit(null);
      setMixOutEdit(null);
    }
  }, [open, track.id, track.start_s]);

  // Resolve the SoundCloud original + its stream URL when the dialog
  // opens. Shazam rows have no soundcloud_id, so fall back to a
  // title+artist search (same as the tracklist's "find on SoundCloud")
  // rather than giving up with "no match".
  useEffect(() => {
    if (!open) {
      setScId(null);
      setScMeta(null);
      setStreamUrl(null);
      setStreamError(null);
      setScResolving(false);
      return;
    }
    let cancelled = false;
    setStreamError(null);
    setScResolving(true);
    void (async () => {
      let id: number | null = soundcloudId;
      let hit: SCTrack | null = null;
      if (id != null) {
        // Persisted / find-resolved id: fetch the track for its waveform.
        hit = await getTrack(`soundcloud:tracks:${id}`).catch(() => null);
      } else if (trackTitle) {
        // Shazam row: the backend's matcher checks title, artist, remixer
        // and length, so a loose top search hit isn't streamed as the
        // original. It also saves the link.
        id = await linkSoundcloudTrack(jobId, trackId)
          .then((r) => r.soundcloud_id)
          .catch(() => null);
        if (id != null) {
          hit = await getTrack(`soundcloud:tracks:${id}`).catch(() => null);
        }
      }
      if (cancelled) return;
      setScId(id);
      setScMeta(
        hit
          ? {
              waveformUrl: hit.waveform_url ?? null,
              durationS:
                hit.duration != null && hit.duration > 0
                  ? hit.duration / 1000
                  : 0,
            }
          : null,
      );
      setScResolving(false);
      if (id == null) {
        setStreamUrl(null);
        return;
      }
      try {
        const url = await getCachedSoundcloudStreamUrl(id);
        if (!cancelled) setStreamUrl(url);
      } catch (err) {
        if (!cancelled) {
          setStreamError(err instanceof Error ? err.message : String(err));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, soundcloudId, trackTitle, jobId, trackId]);

  // Fetch the server-decoded peaks + detected tempo once the original id is
  // known, before the SC strip builds — so the speed ratio (which drives the
  // strip's horizontal scale) is settled by render time.
  useEffect(() => {
    setScDecoded(null);
    setScDecodedResolved(false);
    if (!open || scId == null) return;
    let cancelled = false;
    void getCachedSoundcloudDecodedPeaks(scId)
      .catch(() => null)
      .then((d) => {
        if (cancelled) return;
        setScDecoded(d);
        setScDecodedResolved(true);
      });
    return () => {
      cancelled = true;
    };
  }, [open, scId]);

  // Suggest a position from the audio. Skipped for rows the user already
  // aligned, and dropped if they moved a strip while it ran. Centring the
  // original's 0:00 on the suggestion keeps the saved start exact whatever
  // speed ratio the dialog settles on.
  const positionsRef = useRef({ mix: mixCenterS, orig: origCenterS });
  positionsRef.current = { mix: mixCenterS, orig: origCenterS };
  // A BPM change reruns it: the tempo sets the playback rates it searches,
  // and the new result moves the strips even if the user had moved them.
  const alignBpm = scDecodedResolved ? (scDecoded?.bpm ?? null) : undefined;
  const lastAlignBpmRef = useRef<number | null | undefined>(undefined);
  useEffect(() => {
    setAutoAlign(null);
    if (!open || scId == null || alignBpm === undefined) {
      // A new track or reopen starts fresh, not as a BPM change.
      lastAlignBpmRef.current = undefined;
      return;
    }
    const bpmChanged =
      lastAlignBpmRef.current !== undefined &&
      lastAlignBpmRef.current !== alignBpm;
    lastAlignBpmRef.current = alignBpm;
    if (track.aligned && !bpmChanged) return;
    let cancelled = false;
    setAutoAlign("running");
    void autoAlignTrack(jobId, track.id, scId)
      .catch((): AutoAlignResult => ({ found: false }))
      .then((r) => {
        if (cancelled) return;
        setAutoAlign(r);
        const untouched =
          positionsRef.current.mix === track.start_s &&
          positionsRef.current.orig === 0;
        if (!r.found || !(untouched || bpmChanged)) return;
        setMixCenterS(Math.max(0, r.start_s));
        setOrigCenterS(0);
      });
    return () => {
      cancelled = true;
    };
  }, [open, scId, alignBpm, jobId, track.id, track.start_s, track.aligned]);

  // Mix deck: a plain media element on the cached set (Range-served), and
  // peaks for just the region around the track, so nothing decodes the
  // whole multi-hour set in the browser.
  useEffect(() => {
    setSetReady(false);
    setMixPeaks(null);
    if (!open) return;
    const audio = new Audio(jobAudioUrl(jobId));
    audio.preload = "auto";
    setAudioRef.current = audio;
    const onEnded = () => setTransport(false);
    audio.addEventListener("ended", onEnded);
    let cancelled = false;
    const reach = (track.duration_s ?? 600) + MIX_MARGIN_S;
    void getSetPeaks(jobId, track.start_s - reach, track.start_s + reach)
      .then((r) => {
        if (cancelled) return;
        setMixPeaks(r);
        setSetReady(true);
      })
      .catch(() => {
        if (!cancelled) setSetReady(true);
      });
    return () => {
      cancelled = true;
      audio.removeEventListener("ended", onEnded);
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
      setAudioRef.current = null;
    };
  }, [open, jobId, track.start_s, track.duration_s]);

  // Original deck: stream the SoundCloud upload (HLS) and paint from the
  // server-decoded peaks, falling back to SoundCloud's coarse waveform.
  useEffect(() => {
    setScReady(false);
    setOrigPeaks(null);
    if (!open || !streamUrl || !scDecodedResolved) return;
    let cancelled = false;
    const audio = new Audio();
    audio.preload = "auto";
    // Attach to the DOM (hidden). A detached, MediaSource-fed element
    // doesn't reliably fire ``loadedmetadata`` in the Tauri webview.
    audio.hidden = true;
    document.body.appendChild(audio);
    const noQuery = streamUrl.split("?")[0] ?? streamUrl;
    if (noQuery.endsWith(".m3u8") && Hls.isSupported()) {
      const hls = new Hls();
      hls.loadSource(streamUrl);
      hls.attachMedia(audio);
      hlsRef.current = hls;
    } else {
      audio.src = streamUrl;
    }
    scAudioRef.current = audio;
    const onEnded = () => setTransport(false);
    audio.addEventListener("ended", onEnded);

    const decoded = scDecodedRef.current;
    void (async () => {
      let peaks: number[] | null =
        decoded && decoded.peaks.length > 0 ? decoded.peaks : null;
      if (!peaks && scMeta?.waveformUrl) {
        peaks = await getCachedSoundcloudPeaks(
          scMeta.waveformUrl,
          SC_FALLBACK_PEAKS,
        );
      }
      if (cancelled) return;
      setOrigPeaks(peaks ?? []);
      setScReady(true);
    })();
    return () => {
      cancelled = true;
      audio.removeEventListener("ended", onEnded);
      hlsRef.current?.destroy();
      hlsRef.current = null;
      audio.pause();
      audio.src = "";
      audio.remove();
      scAudioRef.current = null;
    };
    // ``scDecoded`` is read through a ref: a BPM correction mutates it, and
    // re-running here would re-buffer the stream.
  }, [open, streamUrl, scDecodedResolved, scMeta]);

  // Pitch-match: the SC track plays back faster or slower so the
  // listener hears it at the same tempo as the mix.
  useEffect(() => {
    const audio = scAudioRef.current;
    if (!audio) return;
    audio.playbackRate = 1 / speedRatio;
  }, [speedRatio, scReady]);

  // While playing, one animation-frame loop reads both media clocks and
  // repaints both strips, so they move in lockstep at display rate. Paused,
  // each strip repaints from its position prop instead.
  useEffect(() => {
    if (!isPlaying) return;
    let frame = 0;
    const mixClock = smoothClock();
    const origClock = smoothClock();
    const tick = (now: number) => {
      const mix = setAudioRef.current;
      const orig = scAudioRef.current;
      if (mix) mixStripRef.current?.draw(mixClock(mix, now));
      if (orig) origStripRef.current?.draw(origClock(orig, now));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [isPlaying]);

  // Seek both decks to the strips' positions while paused, so pressing play
  // starts aligned.
  useEffect(() => {
    if (isPlaying) return;
    if (setAudioRef.current) setAudioRef.current.currentTime = mixCenterS;
    if (scAudioRef.current) scAudioRef.current.currentTime = origCenterS;
  }, [isPlaying, mixCenterS, origCenterS, setReady, scReady]);

  // Stop the decks where playback left them, so pausing doesn't snap the
  // strips back to where play started.
  const pauseAt = useCallback(() => {
    const mix = setAudioRef.current;
    const orig = scAudioRef.current;
    mix?.pause();
    orig?.pause();
    if (mix) setMixCenterS(mix.currentTime);
    if (orig) setOrigCenterS(orig.currentTime);
    setTransport(false);
  }, []);

  // Drag either strip horizontally to move its position under the centred
  // playhead. Dragging right moves the waveform right, so the time at the
  // playhead decreases. Mix drag is in set seconds (pxPerSec); original
  // drag in original seconds (scPxPerSec). Pointer-based so trackpad +
  // touch work; range is bounded only by each track's own length.
  const dragRef = useRef<{
    startX: number;
    start: number;
    kind: "mix" | "orig";
  } | null>(null);
  const onMixPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      if (transport) pauseAt();
      const start = setAudioRef.current?.currentTime ?? mixCenterS;
      dragRef.current = {
        startX: e.clientX,
        start: transport ? start : mixCenterS,
        kind: "mix",
      };
      (e.target as HTMLDivElement).setPointerCapture(e.pointerId);
    },
    [mixCenterS, transport, pauseAt],
  );
  const onOrigPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      if (transport) pauseAt();
      const start = scAudioRef.current?.currentTime ?? origCenterS;
      dragRef.current = {
        startX: e.clientX,
        start: transport ? start : origCenterS,
        kind: "orig",
      };
      (e.target as HTMLDivElement).setPointerCapture(e.pointerId);
    },
    [origCenterS, transport, pauseAt],
  );
  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag) return;
      const dx = e.clientX - drag.startX;
      if (drag.kind === "mix") {
        setMixCenterS(clampMix(drag.start - dx / pxPerSec));
      } else {
        setOrigCenterS(clampOrig(drag.start - dx / scPxPerSec));
      }
    },
    [clampMix, clampOrig, pxPerSec, scPxPerSec],
  );
  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    dragRef.current = null;
    (e.target as HTMLDivElement).releasePointerCapture(e.pointerId);
  }, []);

  // Jog BOTH decks together by ``deltaSet`` set-seconds, preserving the
  // alignment: the mix moves ``deltaSet`` and the original moves the same
  // set-time (``deltaSet / speedRatio`` original-seconds), so
  // ``newStartS = mix - orig*speedRatio`` is unchanged. Lets you scrub
  // through the pair to sanity-check the match away from the drop.
  const skipBoth = useCallback(
    (deltaSet: number) => {
      const mixNow = isPlaying
        ? (setAudioRef.current?.currentTime ?? mixCenterS)
        : mixCenterS;
      const origNow = isPlaying
        ? (scAudioRef.current?.currentTime ?? origCenterS)
        : origCenterS;
      const newMix = clampMix(mixNow + deltaSet);
      const newOrig = clampOrig(origNow + deltaSet / speedRatio);
      setMixCenterS(newMix);
      setOrigCenterS(newOrig);
      if (isPlaying) {
        if (setAudioRef.current) setAudioRef.current.currentTime = newMix;
        if (scAudioRef.current) scAudioRef.current.currentTime = newOrig;
      }
    },
    [mixCenterS, origCenterS, speedRatio, clampMix, clampOrig, isPlaying],
  );

  // Stop both players when the dialog closes.
  useEffect(() => {
    if (open) return;
    setAudioRef.current?.pause();
    scAudioRef.current?.pause();
    setTransport(false);
  }, [open]);

  // Apply the headphone cue by (un)muting each deck via its volume — WebKit
  // element decks must fade through ``volume`` rather than a WebAudio graph.
  const applyCue = useCallback((c: "mix" | "original" | "both") => {
    const setAudio = setAudioRef.current;
    const scAudio = scAudioRef.current;
    if (setAudio) setAudio.volume = c === "original" ? 0 : 1;
    if (scAudio) scAudio.volume = c === "mix" ? 0 : 1;
  }, []);

  // Keep the cue applied as decks (re)mount or the selection changes.
  useEffect(() => {
    applyCue(cue);
  }, [applyCue, cue, setReady, scReady]);

  const selectCue = useCallback(
    (c: "mix" | "original" | "both") => {
      setCue(c);
      applyCue(c);
    },
    [applyCue],
  );

  // Transport runs BOTH decks together from the aligned point, phase-locked;
  // the cue decides what's audible. ``playbackRate`` keeps the original at
  // the mix's tempo by ear.
  const togglePlay = useCallback(async () => {
    const setAudio = setAudioRef.current;
    const scAudio = scAudioRef.current;
    if (transport) {
      pauseAt();
      return;
    }
    if (setAudio) setAudio.currentTime = mixCenterS;
    if (scAudio) scAudio.currentTime = origCenterS;
    applyCue(cue);
    try {
      if (scAudio) scAudio.playbackRate = 1 / speedRatio;
      // Don't wait on the original: a stream still buffering would hold the
      // whole transport. It joins once it can play.
      scAudio?.play().catch((err: unknown) => {
        console.warn("alignment: original playback failed", err);
      });
      if (setAudio) await setAudio.play();
      setTransport(true);
    } catch (err) {
      console.warn("alignment: playback failed", err);
      setTransport(false);
    }
  }, [transport, mixCenterS, origCenterS, cue, applyCue, speedRatio, pauseAt]);

  // Where the match says the track plays: tinted on the mix (mix seconds),
  // and on the original its chunks by how they voted. Unique chunks that
  // agree carry the match and get the strongest tint.
  const found =
    autoAlign !== null && autoAlign !== "running" && autoAlign.found
      ? autoAlign
      : null;
  // Where the track is audible. The mix start is the original's 0:00, which
  // for a track mixed in partway can sit long before it is heard. A match
  // is shifted by however far the user moved the start since.
  const shift = found ? newStartS - found.start_s : 0;
  const mixIn =
    mixInEdit ?? (found ? found.enter_s + shift : (track.mix_in_s ?? null));
  const mixOut =
    mixOutEdit ?? (found ? found.exit_s + shift : (track.mix_out_s ?? null));
  const entry =
    mixIn != null
      ? (() => {
          const mixS = Math.max(newStartS, mixIn);
          return { mixS, origS: (mixS - newStartS) / speedRatio };
        })()
      : null;
  const mixBands: StripBand[] =
    mixIn != null && mixOut != null
      ? [{ startS: mixIn, endS: mixOut, token: "--color-brand", alpha: 0.1 }]
      : [];
  const mixMarkers: StripMarker[] = found
    ? [{ atS: found.start_s, token: "--color-brand" }]
    : [];
  const origBands: StripBand[] = agreeingSpans(found?.chunks ?? []).map(
    (span) => ({
      startS: span.startS,
      endS: span.endS,
      token: "--color-brand",
      alpha: 0.04 + 0.14 * span.uniqueness,
    }),
  );

  // ``markAligned`` promotes the row to the highest curation tier
  // (confirmed + alignment-verified) as part of the save, so the user can
  // sign off the alignment right after nudging.
  const currentMixS = () =>
    isPlaying ? (setAudioRef.current?.currentTime ?? mixCenterS) : mixCenterS;

  const save = useCallback(
    async (markAligned: boolean) => {
      if (saving) return;
      setSaving(true);
      setSaveError(null);
      try {
        await updateTrack(jobId, track.id, {
          start_s: newStartS,
          ...(mixIn != null && mixOut != null && mixOut > mixIn
            ? { mix_in_s: mixIn, mix_out_s: mixOut }
            : {}),
          ...(markAligned ? { confirmed: true, aligned: true } : {}),
        });
        onSaved?.(newStartS);
        onOpenChange(false);
      } catch (err) {
        setSaveError(err instanceof Error ? err.message : String(err));
      } finally {
        setSaving(false);
      }
    },
    [jobId, newStartS, mixIn, mixOut, onOpenChange, onSaved, saving, track.id],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[90dvh] w-[min(96vw,90rem)] overflow-y-auto sm:max-w-none"
        data-testid="alignment-dialog"
      >
        <DialogHeader>
          <DialogTitle>Align &ldquo;{track.title}&rdquo;</DialogTitle>
          <DialogDescription>
            Line up the kicks under the centre line: drag either waveform to
            move it, zoom in for finer control, then save.
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-w-0 flex-col gap-3">
          <div className="border-border bg-surface-2 flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg border px-3 py-2">
            <div className="flex flex-col">
              <span className="text-text-subtle text-2xs tracking-wider uppercase">
                Mix start
              </span>
              <div className="flex items-baseline gap-3">
                <span
                  className="text-text text-xl tabular-nums"
                  data-testid="alignment-new-start"
                >
                  {formatTimecode(newStartS)}
                </span>
                <span className="text-text-subtle text-xs tabular-nums">
                  {offsetS >= 0 ? "+" : "−"}
                  {Math.abs(offsetS).toFixed(2)} s vs. detected{" "}
                  {formatTimecode(track.start_s)}
                </span>
              </div>
            </div>
            <MixPoint
              label="Comes in"
              testId="alignment-entry"
              atS={entry?.mixS ?? null}
              detail={
                entry ? `${formatTimecode(entry.origS)} into the track` : null
              }
              onSetHere={() => setMixInEdit(currentMixS())}
            />
            <MixPoint
              label="Goes out"
              testId="alignment-exit"
              atS={mixOut}
              detail={null}
              onSetHere={() => setMixOutEdit(currentMixS())}
            />
            {autoAlign != null && <AutoAlignBadge state={autoAlign} />}
            {found && (
              <p
                className="text-text-subtle text-2xs ml-auto flex flex-wrap items-center gap-x-3 gap-y-1"
                data-testid="alignment-match-legend"
              >
                <span className="inline-flex items-center gap-1.5">
                  <span className="bg-brand inline-block h-3 w-0.5" />
                  suggested start
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="bg-brand/20 inline-block size-3 rounded-xs" />
                  where the track plays · original: brighter = more unique part,
                  weighs more in the match
                </span>
              </p>
            )}
          </div>

          {/* Set waveform — top strip, drag to move the mix. */}
          <div className="flex min-w-0 flex-col gap-1">
            <div className="flex items-baseline justify-between">
              <div className="flex items-baseline gap-2">
                <span className="text-text-muted text-2xs tracking-wider uppercase">
                  Mix
                </span>
                {mixBpm != null && (
                  <span
                    className="text-text-subtle text-2xs tabular-nums"
                    data-testid="alignment-mix-bpm"
                  >
                    {mixBpm.toFixed(1)} BPM
                  </span>
                )}
              </div>
              <span className="text-text-subtle text-2xs">
                drag to move the mix
              </span>
            </div>
            <WaveformStrip
              ready={setReady}
              testId="alignment-set-strip"
              strip={
                mixPeaks && (
                  <PeakStrip
                    ref={mixStripRef}
                    peaks={mixPeaks.peaks}
                    peaksPerS={mixPeaks.peaks_per_s}
                    startS={mixPeaks.start_s}
                    pxPerS={pxPerSec}
                    bands={mixBands}
                    markers={mixMarkers}
                    centerS={mixCenterS}
                  />
                )
              }
              onPointerDown={onMixPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
            />
          </div>

          {/* SC waveform — bottom strip, drag to move the original. */}
          <div className="flex min-w-0 flex-col gap-1">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-text-muted text-2xs tracking-wider uppercase">
                  Original
                </span>
                {origBpm != null && !bpmEditing && (
                  <span
                    className="text-text-subtle text-2xs tabular-nums"
                    data-testid="alignment-orig-bpm"
                  >
                    {origBpm.toFixed(1)} BPM
                    {(bpmRatio != null || track.pitch_offset != null) &&
                      ` · ${mixSpeedFactor.toFixed(3)}× in mix`}
                  </span>
                )}
                {scId != null &&
                  scDecoded != null &&
                  (bpmEditing ? (
                    <span className="flex items-center gap-1">
                      <Input
                        type="number"
                        inputMode="decimal"
                        value={bpmInput}
                        onChange={(e) => setBpmInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void saveBpmOverride();
                          else if (e.key === "Escape") {
                            setBpmError(null);
                            setBpmEditing(false);
                          }
                        }}
                        autoFocus
                        aria-label="Corrected BPM"
                        className="text-2xs h-6 w-16"
                        data-testid="alignment-bpm-input"
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        onClick={() => void saveBpmOverride()}
                        disabled={bpmBusy}
                        aria-label="Save BPM"
                        data-testid="alignment-bpm-save"
                      >
                        <Check />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        onClick={() => {
                          setBpmError(null);
                          setBpmEditing(false);
                        }}
                        aria-label="Cancel BPM edit"
                        data-testid="alignment-bpm-cancel"
                      >
                        <X />
                      </Button>
                    </span>
                  ) : (
                    <span className="flex items-center gap-1">
                      {scDecoded.overridden && (
                        <span
                          className="text-brand text-2xs"
                          data-testid="alignment-bpm-corrected"
                        >
                          corrected
                        </span>
                      )}
                      {scDecoded.source === "soundcloud" && (
                        <span
                          className="text-text-muted text-2xs"
                          data-testid="alignment-bpm-soundcloud"
                          title="Tempo listed on SoundCloud"
                        >
                          from SoundCloud
                        </span>
                      )}
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        onClick={() => {
                          setBpmInput(
                            origBpm != null ? origBpm.toFixed(1) : "",
                          );
                          setBpmError(null);
                          setBpmEditing(true);
                        }}
                        aria-label="Correct BPM"
                        title="Correct BPM"
                        data-testid="alignment-bpm-edit"
                      >
                        <Pencil />
                      </Button>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-xs"
                            disabled={bpmBusy}
                            aria-label="Reanalyse BPM"
                            title="Reanalyse BPM"
                            data-testid="alignment-bpm-reanalyse"
                          >
                            <RefreshCw
                              className={cn(bpmBusy && "animate-spin")}
                            />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start" className="w-64">
                          <DropdownMenuItem
                            onSelect={() => void reanalyseBpm(false)}
                            data-testid="alignment-bpm-reanalyse-default"
                            className="items-start py-2"
                          >
                            <div className="flex flex-col gap-0.5">
                              <span className="text-sm font-medium">
                                Reanalyse
                              </span>
                              <span className="text-text-muted text-xs">
                                Same algorithm, fresh run
                              </span>
                            </div>
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onSelect={() => void reanalyseBpm(true)}
                            data-testid="alignment-bpm-reanalyse-strong"
                            className="items-start py-2"
                          >
                            <div className="flex flex-col gap-0.5">
                              <span className="text-sm font-medium">
                                Stronger algorithm
                              </span>
                              <span className="text-text-muted text-xs">
                                DP beat tracker, fixes dotted/triplet sub-rate
                                locks
                              </span>
                            </div>
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                      {scDecoded.overridden && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          onClick={() => void revertBpm()}
                          disabled={bpmBusy}
                          aria-label="Revert to detected BPM"
                          title="Revert to detected BPM"
                          data-testid="alignment-bpm-revert"
                        >
                          <RotateCcw />
                        </Button>
                      )}
                    </span>
                  ))}
              </div>
              <span className="text-text-subtle text-2xs">
                drag to move the original
              </span>
            </div>
            {bpmError && (
              <span
                className="text-destructive text-2xs"
                data-testid="alignment-bpm-error"
              >
                {bpmError}
              </span>
            )}
            <WaveformStrip
              ready={scReady}
              testId="alignment-sc-strip"
              strip={
                origPeaks && (
                  <PeakStrip
                    ref={origStripRef}
                    peaks={origPeaks}
                    peaksPerS={
                      origDurationS > 0 ? origPeaks.length / origDurationS : 1
                    }
                    startS={0}
                    pxPerS={scPxPerSec}
                    bands={origBands}
                    markers={[]}
                    centerS={origCenterS}
                  />
                )
              }
              onPointerDown={onOrigPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              empty={!scResolving && !scId}
              emptyLabel="No SoundCloud match — mix-only alignment."
            />
          </div>

          {/* Control deck on one row under the strips: transport, jog, cue,
              zoom. Wraps on narrow windows. */}
          <div className="border-border bg-surface-2 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border px-3 py-2">
            <PlayButton
              label={transport ? "Pause" : "Play"}
              active={transport}
              disabled={!setReady}
              onClick={() => void togglePlay()}
              testId="alignment-play-toggle"
            />

            <Separator orientation="vertical" className="h-8" />

            <div className="contents">
              <div className="flex items-center gap-2">
                <span className="text-text-subtle text-2xs tracking-wider uppercase">
                  Jog
                </span>
                <div className="border-border bg-surface-1 inline-flex overflow-hidden rounded-md border">
                  {JOG_STEPS_S.map((d, i) => {
                    const Icon =
                      d < 0
                        ? Math.abs(d) >= 30
                          ? ChevronsLeft
                          : ChevronLeft
                        : Math.abs(d) >= 30
                          ? ChevronsRight
                          : ChevronRight;
                    return (
                      <Button
                        key={d}
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => skipBoth(d)}
                        aria-label={`${d > 0 ? "Forward" : "Back"} ${Math.abs(d)} seconds, both decks`}
                        className={cn(
                          "text-text-muted h-8 gap-0.5 rounded-none px-2 tabular-nums",
                          i > 0 && "border-border border-l",
                        )}
                        data-testid={`alignment-jog-${d}`}
                      >
                        {d < 0 && <Icon />}
                        {Math.abs(d)}s{d > 0 && <Icon />}
                      </Button>
                    );
                  })}
                </div>
              </div>

              <div className="flex items-center gap-2">
                <span className="text-text-subtle text-2xs inline-flex items-center gap-1 tracking-wider uppercase">
                  <Headphones className="size-3.5" /> Cue
                </span>
                <ToggleGroup
                  type="single"
                  variant="outline"
                  value={cue}
                  onValueChange={(v) => {
                    if (v) selectCue(v as "mix" | "original" | "both");
                  }}
                  aria-label="Headphone cue"
                >
                  {(
                    [
                      ["mix", "Mix (A)", false],
                      ["original", "Original (B)", true],
                      ["both", "Master", false],
                    ] as const
                  ).map(([value, label, needsSc]) => (
                    <ToggleGroupItem
                      key={value}
                      value={value}
                      disabled={needsSc && !scReady}
                      className="text-text-muted data-[state=on]:bg-brand-soft data-[state=on]:text-brand h-8"
                      data-testid={`alignment-cue-${value}`}
                    >
                      {label}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </div>
            </div>
            <div className="flex min-w-64 flex-1 items-center gap-3">
              <span className="text-text-subtle text-2xs tracking-wider uppercase">
                Zoom
              </span>
              <Slider
                aria-label="Waveform zoom"
                min={MIN_PX_PER_S}
                max={MAX_PX_PER_S}
                step={ZOOM_STEP}
                value={[pxPerSec]}
                onValueChange={([v]) => {
                  if (v != null) setPxPerSec(v);
                }}
                className="flex-1"
                data-testid="alignment-zoom"
              />
              <span
                className="text-text-muted w-10 text-right text-xs tabular-nums"
                data-testid="alignment-zoom-value"
              >
                {(pxPerSec / DEFAULT_PX_PER_S).toFixed(1)}×
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={() => setPxPerSec(DEFAULT_PX_PER_S)}
                disabled={pxPerSec === DEFAULT_PX_PER_S}
                aria-label="Reset zoom"
                title="Reset zoom"
                data-testid="alignment-zoom-reset"
              >
                <RotateCcw />
              </Button>
            </div>
          </div>
          {streamError && (
            <span className="text-destructive text-xs">{streamError}</span>
          )}
        </div>

        <DialogFooter>
          {saveError && (
            <span
              className="text-destructive mr-auto text-xs"
              data-testid="alignment-save-error"
            >
              {saveError}
            </span>
          )}
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => void save(false)}
            disabled={saving || Math.abs(offsetS) < 1e-3}
            data-testid="alignment-save"
          >
            {saving ? "Saving…" : "Save alignment"}
          </Button>
          {/* Highest tier: save the start and sign off the alignment. Always
              available — you may want to mark it correct without nudging. */}
          <Button
            type="button"
            onClick={() => void save(true)}
            disabled={saving}
            data-testid="alignment-save-aligned"
          >
            <BadgeCheck className="size-4" />
            {saving ? "Saving…" : "Save & mark aligned"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Auto-align status: running, the suggestion's confidence and tempo
 *  mode, or a miss. */
function AutoAlignBadge({ state }: { state: "running" | AutoAlignResult }) {
  const base =
    "text-xs inline-flex items-center gap-1.5 rounded-xs px-1.5 py-0.5 font-medium";
  if (state === "running") {
    return (
      <span
        className={cn(base, "bg-surface-3 text-text-muted")}
        data-testid="alignment-auto-status"
      >
        <Loader2 className="size-3 animate-spin" />
        Finding the track in the mix…
      </span>
    );
  }
  if (!state.found) {
    return (
      <span
        className={cn(base, "bg-surface-3 text-text-muted")}
        data-testid="alignment-auto-status"
      >
        <SearchX className="size-3" />
        Not found in the mix, align by hand
      </span>
    );
  }
  return (
    <span
      className={cn(base, "bg-surface-3 text-text-muted")}
      data-testid="alignment-auto-status"
      title={`Playback rate ${state.rate.toFixed(3)}×`}
    >
      <Sparkles className="text-brand size-3" />
      <span className="text-text">Auto-aligned</span>
      <span className="tabular-nums">
        {Math.round(state.confidence * 100)}% sure
      </span>
      <span aria-hidden>·</span>
      <span>{state.key_lock ? "master tempo" : "pitch fader"}</span>
    </span>
  );
}

/** One mix point (where the track comes in or goes out) with a button to
 *  move it to the playhead, for when the match is a few seconds off. */
function MixPoint({
  label,
  testId,
  atS,
  detail,
  onSetHere,
}: {
  label: string;
  testId: string;
  atS: number | null;
  detail: string | null;
  onSetHere: () => void;
}) {
  return (
    <div className="flex flex-col" data-testid={testId}>
      <span className="text-text-subtle text-2xs tracking-wider uppercase">
        {label}
      </span>
      <div className="flex items-baseline gap-2">
        <span className="text-text text-xl tabular-nums">
          {atS != null ? formatTimecode(atS) : "—"}
        </span>
        {detail && (
          <span className="text-text-subtle text-xs tabular-nums">
            {detail}
          </span>
        )}
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="text-text-muted self-center"
          onClick={onSetHere}
          title={`Set ${label.toLowerCase()} to the playhead`}
          data-testid={`${testId}-set`}
        >
          <Crosshair />
          Set here
        </Button>
      </div>
    </div>
  );
}

function PlayButton({
  label,
  active,
  disabled,
  onClick,
  testId,
}: {
  label: string;
  active: boolean;
  disabled: boolean;
  onClick: () => void;
  testId: string;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      data-testid={testId}
      className={cn(
        "h-8 gap-2 px-4",
        active
          ? "bg-brand-soft text-brand hover:bg-brand-soft"
          : "bg-surface-3 text-text hover:bg-surface-3",
      )}
    >
      {active ? <Pause className="size-4" /> : <Play className="size-4" />}
      {label}
    </Button>
  );
}

interface WaveformStripProps {
  strip: React.ReactNode;
  ready: boolean;
  testId: string;
  onPointerDown?: (e: React.PointerEvent<HTMLDivElement>) => void;
  onPointerMove?: (e: React.PointerEvent<HTMLDivElement>) => void;
  onPointerUp?: (e: React.PointerEvent<HTMLDivElement>) => void;
  onPointerCancel?: (e: React.PointerEvent<HTMLDivElement>) => void;
  empty?: boolean;
  emptyLabel?: string;
}

/** Frame for one waveform: the strip, a centred playhead, and a drag
 *  overlay, so both decks look and behave the same. */
function WaveformStrip({
  strip,
  ready,
  testId,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  empty,
  emptyLabel,
}: WaveformStripProps) {
  return (
    <div
      className="border-border bg-surface-2 relative h-28 w-full min-w-0 overflow-hidden rounded-md border"
      data-testid={testId}
    >
      {empty ? (
        <div className="text-text-subtle absolute inset-0 grid place-items-center text-xs">
          {emptyLabel}
        </div>
      ) : (
        <>
          {strip}
          {!ready && (
            <div
              className="text-text-subtle absolute inset-0 grid place-items-center"
              data-testid="waveform-loading"
            >
              <Loader2 className="size-5 animate-spin" />
            </div>
          )}
          {/* Centred playhead — on both strips this column corresponds
              to the same set-time, so when bars line up across both
              strips at the centre, the kicks are aligned. */}
          <div
            aria-hidden
            className="bg-brand pointer-events-none absolute top-0 bottom-0 left-1/2 w-px"
          />
          {onPointerDown && (
            <div
              className="absolute inset-0 z-10 cursor-ew-resize"
              // ``touchAction: none`` keeps the browser from scrolling
              // the page when the user drag-nudges with a touch device.
              style={{ touchAction: "none" }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerCancel}
              data-testid={`${testId}-drag`}
            />
          )}
        </>
      )}
    </div>
  );
}
