"use client";

import Hls from "hls.js";
import {
  BadgeCheck,
  Check,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Headphones,
  Loader2,
  Pause,
  Pencil,
  Play,
  RefreshCw,
  RotateCcw,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type WaveSurferType from "wavesurfer.js";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Slider } from "@/components/ui/slider";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  formatTimecode,
  jobAudioUrl,
  originalBpmFromSet,
  pitchSpeedRatio,
  updateTrack,
  type TrackTimelineEntry,
} from "@/lib/analyser";
import { api } from "@/lib/api";
import { getTrack, searchTracks, type SCTrack } from "@/lib/soundcloud";
import {
  getCachedSoundcloudDecodedPeaks,
  getCachedSoundcloudPeaks,
  getCachedSoundcloudStreamUrl,
  updateCachedSoundcloudBpm,
  type DecodedPeaks,
} from "@/lib/soundcloud-cache";
import { cn } from "@/lib/utils";

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
/** Floor for the SoundCloud peak count. The bake request scales with the
 *  rendered pixel width at MAX zoom so bars stay crisp when zoomed all the
 *  way in; this only guards very short originals and sizes the fallback
 *  silhouette. */
const SC_NUM_PEAKS = 1000;
/** Accepted original-BPM correction range, mirroring the backend's 40–300
 *  guard so an out-of-range value is caught before the request. */
const BPM_MIN = 40;
const BPM_MAX = 300;

function scNumericId(t: SCTrack): number | null {
  const direct = (t as { id?: number | string }).id;
  if (typeof direct === "number") return direct;
  if (typeof direct === "string" && /^\d+$/.test(direct)) return Number(direct);
  const tail = t.urn?.split(":").pop();
  return tail && /^\d+$/.test(tail) ? Number(tail) : null;
}
// Fallback silhouette when a SoundCloud track exposes no waveform data,
// so the strip renders instead of spinning forever.
const SC_PLACEHOLDER_PEAKS = Array.from(
  { length: SC_NUM_PEAKS },
  (_, i) => 0.25 + 0.6 * Math.abs(Math.sin(i * 0.12)),
);

/** A/B comparison + manual alignment for a Shazam-identified track.
 *
 *  Renders the cached set audio and the original SoundCloud track as
 *  two stacked WaveSurfer waveforms with a shared centre playhead. The
 *  user drags either waveform horizontally (zooming in for finer control)
 *  until kicks line up by eye, then saves. The saved start is computed
 *  from both positions. Transport plays both decks together
 *  (phase-locked, original at ``1 / pitchSpeedRatio(pitch_offset)`` to
 *  match the mix's tempo); a DJ-style cue picks what you hear — the mix
 *  (A), the original (B), or both (master).
 *
 *  Auto cross-correlation is intentionally still out of scope — manual
 *  alignment first, server-side correlation as a follow-up. */
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
  const trackArtist = track.artist ?? null;

  // Container nodes tracked as state (via callback refs) so the mount
  // effects fire once the portaled dialog content actually attaches them —
  // a plain ref reads null on the first effect pass and never retries.
  const [setContainerEl, setSetContainerEl] = useState<HTMLDivElement | null>(
    null,
  );
  const [scContainerEl, setScContainerEl] = useState<HTMLDivElement | null>(
    null,
  );
  const setWsRef = useRef<WaveSurferType | null>(null);
  const scWsRef = useRef<WaveSurferType | null>(null);
  const setAudioRef = useRef<HTMLAudioElement | null>(null);
  const scAudioRef = useRef<HTMLAudioElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);

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
  const [saveError, setSaveError] = useState<string | null>(null);

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
  const origDurationBound =
    scMeta?.durationS != null && scMeta.durationS > 0 ? scMeta.durationS : null;
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
      ? scDecoded.bpm / track.set_bpm
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
    (bpm: number | null, overridden: boolean) => {
      setScDecoded((prev) => (prev ? { ...prev, bpm, overridden } : prev));
      if (scId != null) updateCachedSoundcloudBpm(scId, bpm, overridden);
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
      applyDecodedBpm(r.bpm, r.bpm_overridden);
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
      applyDecodedBpm(r.bpm, r.bpm_overridden);
    } catch (err) {
      setBpmError(err instanceof Error ? err.message : String(err));
    } finally {
      setBpmBusy(false);
    }
  }, [scId, applyDecodedBpm]);

  const reanalyseBpm = useCallback(async () => {
    if (scId == null) return;
    setBpmBusy(true);
    setBpmError(null);
    try {
      const r = await api.reanalyseSoundcloudTrackBpm(scId);
      applyDecodedBpm(r.bpm, r.bpm_overridden);
    } catch (err) {
      setBpmError(err instanceof Error ? err.message : String(err));
    } finally {
      setBpmBusy(false);
    }
  }, [scId, applyDecodedBpm]);

  // SC plays at ``1/speedRatio`` to match set tempo. Visually we
  // compensate by stretching the SC waveform so 1 px = same set-time
  // as the set strip. Internal px-per-original-second is reduced
  // accordingly.
  const scPxPerSec = pxPerSec * speedRatio;

  // Live-zoom mirrors read by the once-created scroll handlers, plus the
  // baked SC lead-in pad (seconds) so those handlers centre correctly at
  // any zoom (the pad is sized for the widest — min-zoom — viewport).
  const pxPerSecRef = useRef(pxPerSec);
  const scPxPerSecRef = useRef(scPxPerSec);
  const scPadSRef = useRef(0);
  pxPerSecRef.current = pxPerSec;
  scPxPerSecRef.current = scPxPerSec;
  // Mirrors read by the SC-strip build so it can bake from the current
  // decoded peaks + speed ratio without listing them as effect deps — a BPM
  // correction mutates both, and re-running the effect would tear down and
  // re-buffer the HLS stream. Scale changes are applied live via ``ws.zoom``.
  const scDecodedRef = useRef(scDecoded);
  const speedRatioRef = useRef(speedRatio);
  scDecodedRef.current = scDecoded;
  speedRatioRef.current = speedRatio;

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
        // Shazam row: resolve via search (its hit already carries the
        // waveform + duration).
        try {
          const q = `${trackTitle} ${trackArtist ?? ""}`.trim();
          const hits = q ? await searchTracks(q, 1) : [];
          hit = hits[0] ?? null;
          id = hit ? scNumericId(hit) : null;
        } catch {
          hit = null;
          id = null;
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
  }, [open, soundcloudId, trackTitle, trackArtist]);

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

  // Mount the SET waveform when the dialog opens. Let WaveSurfer own the
  // media element (URL mode, same as the main set waveform) — decoding a
  // detached ``new Audio()`` element left the strip stuck on "loading".
  useEffect(() => {
    if (!open) return;
    const container = setContainerEl;
    if (!container) return;
    let cancelled = false;
    let teardown: (() => void) | null = null;
    setSetReady(false);
    void (async () => {
      const { default: WaveSurfer } = await import("wavesurfer.js");
      if (cancelled || !container) return;
      const cs = getComputedStyle(document.documentElement);
      const colour = (token: string, fallback: string) => {
        const v = cs.getPropertyValue(token).trim();
        return v.length > 0 ? v : fallback;
      };
      const ws = WaveSurfer.create({
        container,
        url: jobAudioUrl(jobId),
        height: 80,
        waveColor: colour("--color-text-subtle", "#888"),
        progressColor: colour("--color-brand", "#a0e060"),
        cursorColor: colour("--color-brand-active", "#84c441"),
        cursorWidth: 0,
        barWidth: 2,
        barGap: 1,
        barRadius: 1,
        normalize: true,
        minPxPerSec: pxPerSecRef.current,
        autoScroll: false,
        interact: true,
        duration: setDurationS && setDurationS > 0 ? setDurationS : undefined,
      });
      setWsRef.current = ws;
      setAudioRef.current = ws.getMediaElement();
      ws.on("ready", () => {
        if (cancelled) return;
        setSetReady(true);
      });
      // Follow the playhead by scrolling the strip so the current mix
      // time stays under the centred playhead. WaveSurfer's scroll lives
      // in a shadow-DOM child, so ``ws.setScroll`` is the only way to move
      // it — setting the container's ``scrollLeft`` is a no-op.
      ws.on("timeupdate", (t: number) => {
        ws.setScroll(t * pxPerSecRef.current - container.clientWidth / 2);
      });
      ws.on("finish", () => setTransport(false));
      teardown = () => {
        try {
          ws.destroy();
        } catch {
          /* already torn down */
        }
      };
    })();
    return () => {
      cancelled = true;
      teardown?.();
      setWsRef.current = null;
      setAudioRef.current = null;
    };
  }, [open, jobId, setDurationS, setContainerEl]);

  // Mount the SC original waveform when the stream URL resolves. Wait for the
  // decoded-peaks fetch to resolve first so ``speedRatio`` (BPM-derived) is
  // settled before we bake the strip's scale — otherwise it would rebuild
  // (and re-buffer the stream) when the tempo arrived.
  useEffect(() => {
    if (!open) return;
    const container = scContainerEl;
    if (!container || !streamUrl || !scDecodedResolved) return;
    let cancelled = false;
    let teardown: (() => void) | null = null;
    setScReady(false);
    void (async () => {
      const { default: WaveSurfer } = await import("wavesurfer.js");
      if (cancelled || !container) return;
      const audio = new Audio();
      audio.preload = "auto";
      // Attach to the DOM (hidden). A detached, MediaSource-fed element
      // doesn't reliably fire ``loadedmetadata`` in the Tauri webview,
      // which is where the SC duration comes from when the API omits it.
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

      // The element is fed by hls.js via MediaSource, so it has no fetchable
      // ``src`` for WaveSurfer to decode. Paint from precomputed peaks
      // instead. Prefer the server-decoded duration (matches the decoded
      // peaks), then the API duration, then the element's own metadata.
      const decoded = scDecodedRef.current;
      const speed = speedRatioRef.current;
      const apiDuration =
        decoded?.durationS != null && decoded.durationS > 0
          ? decoded.durationS
          : (scMeta?.durationS ?? 0);

      const cs = getComputedStyle(document.documentElement);
      const colour = (token: string, fallback: string) => {
        const v = cs.getPropertyValue(token).trim();
        return v.length > 0 ? v : fallback;
      };
      // Build the waveform once the duration is known. Request ~one peak
      // per two rendered pixels so the bars stay crisp at this zoom — the
      // old fixed 1000-peak downsample smeared each peak across many pixels,
      // which read as a coarse, "too wide" strip next to the full-resolution
      // mix.
      const buildFor = async (origDuration: number) => {
        if (cancelled || scWsRef.current || !container || origDuration <= 0)
          return;
        // Pad the front with a lead-in of silence so the original's t=0 can
        // sit under the centred playhead (WaveSurfer can't scroll before
        // t=0). Size it for the widest — MIN-zoom — viewport so it's always
        // enough; the scroll handlers account for the exact pad at any zoom
        // via ``(scPadS + t) * scPxPerSec - halfW``.
        const halfW = (container.clientWidth || 600) / 2;
        // Pad is baked once and not rebuilt on a later BPM correction, which
        // can lower ``speed`` (and so raise the pad the min-zoom viewport
        // needs). Size it for half the current ratio — enough headroom for a
        // downward-octave correction to still centre t=0 without a rebuild.
        const scPadS = halfW / (MIN_PX_PER_S * (speed / 2));
        scPadSRef.current = scPadS;
        // Bake peaks dense enough for the MOST zoomed-in view; WaveSurfer
        // downsamples for lower zoom and ``ws.zoom`` re-renders from these
        // without another fetch, so zooming in stays crisp.
        const maxWidthPx = (scPadS + origDuration) * (MAX_PX_PER_S * speed);
        const targetPeaks = Math.min(
          20000,
          Math.max(SC_NUM_PEAKS, Math.ceil(maxWidthPx / 2)),
        );
        // Prefer high-res peaks decoded server-side from the actual audio
        // (fetched into ``scDecoded`` before this effect ran). SoundCloud's
        // waveform_url is too coarse (~1 sample/100ms) and tiles into
        // repeating blocks when zoomed in; fall back to it only if the decode
        // endpoint had nothing.
        let base: number[];
        if (decoded && decoded.peaks.length > 0) {
          base = decoded.peaks;
        } else {
          const rawPeaks = scMeta?.waveformUrl
            ? await getCachedSoundcloudPeaks(scMeta.waveformUrl, targetPeaks)
            : null;
          if (cancelled || scWsRef.current || !container) return;
          base = rawPeaks ?? SC_PLACEHOLDER_PEAKS;
        }
        // The decoded peaks span the audio's *real* duration, which can differ
        // from SoundCloud's API duration by a second or two. Scale the strip's
        // time axis to whichever produced ``base`` so kicks don't drift over
        // distance and the playhead follows real playback time.
        const effectiveDuration =
          decoded && decoded.durationS > 0 ? decoded.durationS : origDuration;
        const secPerPeak = effectiveDuration / base.length;
        const padCount = secPerPeak > 0 ? Math.round(scPadS / secPerPeak) : 0;
        const paddedPeaks = [...new Array<number>(padCount).fill(0), ...base];
        const ws = WaveSurfer.create({
          container,
          media: audio,
          height: 80,
          waveColor: colour("--color-text-subtle", "#888"),
          // Hide the built-in progress fill: the padded waveform width no
          // longer matches the media's real duration, so the fill would sit
          // in the wrong place. The centred playhead marks position instead.
          progressColor: colour("--color-text-subtle", "#888"),
          cursorColor: colour("--color-brand-active", "#84c441"),
          cursorWidth: 0,
          barWidth: 2,
          barGap: 1,
          barRadius: 1,
          normalize: true,
          // Visually 1 px = 1/pxPerSec of *set* time for both strips,
          // achieved by scaling the SC's px-per-second by the speed
          // ratio. Listening playback rate is set separately on the audio
          // element so the SC plays at set tempo by ear too.
          minPxPerSec: scPxPerSecRef.current,
          autoScroll: false,
          // The drag overlay owns pointer interaction; disable WaveSurfer's
          // own click-to-seek so it can't fight our manual scroll.
          interact: false,
          peaks: [paddedPeaks],
          duration: scPadS + effectiveDuration,
        });
        scWsRef.current = ws;
        ws.on("ready", () => {
          if (!cancelled) setScReady(true);
        });
        // Follow the playhead: centre original-time ``t`` at the current zoom.
        ws.on("timeupdate", (t: number) => {
          ws.setScroll(
            (scPadSRef.current + t) * scPxPerSecRef.current -
              (container.clientWidth || 0) / 2,
          );
        });
      };
      const onMeta = () => {
        if (Number.isFinite(audio.duration) && audio.duration > 0) {
          void buildFor(audio.duration);
        }
      };
      if (apiDuration > 0) void buildFor(apiDuration);
      else audio.addEventListener("loadedmetadata", onMeta, { once: true });

      teardown = () => {
        audio.removeEventListener("loadedmetadata", onMeta);
        audio.removeEventListener("ended", onEnded);
        try {
          scWsRef.current?.destroy();
        } catch {
          /* already torn down */
        }
        hlsRef.current?.destroy();
        hlsRef.current = null;
        audio.pause();
        audio.src = "";
        audio.remove();
      };
    })();
    return () => {
      cancelled = true;
      teardown?.();
      scWsRef.current = null;
      scAudioRef.current = null;
    };
    // Zoom is NOT a dependency: it's applied live via ``ws.zoom`` so this
    // effect (which loads the HLS stream) doesn't re-run — and re-buffer —
    // on every slider tick. ``speedRatio`` and ``scDecoded`` are read through
    // refs, NOT deps: a BPM correction mutates both, and rebuilding here would
    // re-buffer the stream. Their initial values are settled before this runs
    // (gated on ``scDecodedResolved``); later changes reach the strip live via
    // the zoom effect (scale) and the playbackRate effect (tempo).
  }, [open, streamUrl, scDecodedResolved, scMeta, scContainerEl]);

  // Pitch-match: the SC track plays back faster or slower so the
  // listener hears it at the same tempo as the mix.
  useEffect(() => {
    const audio = scAudioRef.current;
    if (!audio) return;
    audio.playbackRate = 1 / speedRatio;
  }, [speedRatio, scReady]);

  // Apply zoom live to both strips: ``ws.zoom`` re-renders from the already-
  // loaded peaks/decoded data, so it costs no fetch and doesn't re-buffer the
  // SC stream. Re-centring is left to the paused effect (below) or, during
  // playback, the next ``timeupdate`` tick.
  useEffect(() => {
    try {
      if (setReady) setWsRef.current?.zoom(pxPerSec);
    } catch {
      /* not ready to zoom yet */
    }
    try {
      if (scReady) scWsRef.current?.zoom(scPxPerSec);
    } catch {
      /* not ready to zoom yet */
    }
  }, [pxPerSec, scPxPerSec, setReady, scReady]);

  // Position both strips while paused, each centred on its own position,
  // and seek the media elements there so pressing play starts aligned.
  // During playback the per-strip ``timeupdate`` handlers own the scroll
  // (they follow the playhead), so this only runs when paused.
  useEffect(() => {
    if (isPlaying) return;
    const setWs = setWsRef.current;
    const scWs = scWsRef.current;
    const setC = setContainerEl;
    const scC = scContainerEl;
    if (setWs && setC && setReady) {
      if (setAudioRef.current) setAudioRef.current.currentTime = mixCenterS;
      setWs.setScroll(mixCenterS * pxPerSec - setC.clientWidth / 2);
    }
    if (scWs && scC && scReady) {
      if (scAudioRef.current) scAudioRef.current.currentTime = origCenterS;
      scWs.setScroll(
        (scPadSRef.current + origCenterS) * scPxPerSec - scC.clientWidth / 2,
      );
    }
  }, [
    isPlaying,
    mixCenterS,
    origCenterS,
    pxPerSec,
    scPxPerSec,
    setReady,
    scReady,
    setContainerEl,
    scContainerEl,
  ]);

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
  // Pause both decks when a drag begins. While playing, the ``timeupdate``
  // handlers own the scroll (following the playhead) and the paused-position
  // effect is gated off, so a drag would silently shift ``newStartS`` with no
  // visible or audible effect. Pausing hands control to the paused-position
  // effect so the drag actually moves the strip and seeks the deck.
  const pauseTransport = useCallback(() => {
    setAudioRef.current?.pause();
    scAudioRef.current?.pause();
    setTransport(false);
  }, []);
  const onMixPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      pauseTransport();
      dragRef.current = { startX: e.clientX, start: mixCenterS, kind: "mix" };
      (e.target as HTMLDivElement).setPointerCapture(e.pointerId);
    },
    [mixCenterS, pauseTransport],
  );
  const onOrigPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      pauseTransport();
      dragRef.current = { startX: e.clientX, start: origCenterS, kind: "orig" };
      (e.target as HTMLDivElement).setPointerCapture(e.pointerId);
    },
    [origCenterS, pauseTransport],
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
      const newMix = clampMix(mixCenterS + deltaSet);
      const newOrig = clampOrig(origCenterS + deltaSet / speedRatio);
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
      setAudio?.pause();
      scAudio?.pause();
      setTransport(false);
      return;
    }
    if (setAudio) setAudio.currentTime = mixCenterS;
    if (scAudio) scAudio.currentTime = origCenterS;
    applyCue(cue);
    try {
      if (scAudio) scAudio.playbackRate = 1 / speedRatio;
      if (setAudio) await setAudio.play();
      if (scAudio) await scAudio.play();
      setTransport(true);
    } catch (err) {
      console.warn("alignment: playback failed", err);
      setTransport(false);
    }
  }, [transport, mixCenterS, origCenterS, cue, applyCue, speedRatio]);

  // ``markAligned`` promotes the row to the highest curation tier
  // (confirmed + alignment-verified) as part of the save, so the user can
  // sign off the alignment right after nudging.
  const save = useCallback(
    async (markAligned: boolean) => {
      if (saving) return;
      setSaving(true);
      setSaveError(null);
      try {
        await updateTrack(jobId, track.id, {
          start_s: newStartS,
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
    [jobId, newStartS, onOpenChange, onSaved, saving, track.id],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[90dvh] max-w-2xl overflow-y-auto"
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
          <div className="border-border bg-surface-2 flex items-baseline justify-between gap-3 rounded-lg border px-3 py-2">
            <div className="flex flex-col">
              <span className="text-text-subtle text-2xs tracking-wider uppercase">
                Mix start
              </span>
              <span
                className="text-text text-xl tabular-nums"
                data-testid="alignment-new-start"
              >
                {formatTimecode(newStartS)}
              </span>
            </div>
            <div className="text-text-subtle flex flex-col items-end text-xs">
              <span>
                {offsetS >= 0 ? "+" : ""}
                {offsetS.toFixed(2)} s vs. detected (
                {formatTimecode(track.start_s)})
              </span>
            </div>
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
              containerRef={setSetContainerEl}
              ready={setReady}
              testId="alignment-set-strip"
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
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        onClick={() => void reanalyseBpm()}
                        disabled={bpmBusy}
                        aria-label="Reanalyse BPM"
                        title="Reanalyse BPM"
                        data-testid="alignment-bpm-reanalyse"
                      >
                        <RefreshCw className={cn(bpmBusy && "animate-spin")} />
                      </Button>
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
              containerRef={setScContainerEl}
              ready={scReady}
              testId="alignment-sc-strip"
              onPointerDown={onOrigPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              empty={!scResolving && !scId}
              emptyLabel="No SoundCloud match — mix-only alignment."
            />
          </div>

          <div className="flex items-center gap-3">
            <span className="text-text-subtle text-2xs w-8 tracking-wider uppercase">
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

          {/* Control deck: transport on the left, then jog + cue stacked on
              the right with aligned labels — reads as one DJ-mixer unit. */}
          <div className="border-border bg-surface-2 flex items-center gap-3 rounded-lg border px-3 py-3">
            <PlayButton
              label={transport ? "Pause" : "Play"}
              active={transport}
              disabled={!setReady}
              onClick={() => void togglePlay()}
              testId="alignment-play-toggle"
            />

            <Separator orientation="vertical" className="h-12" />

            <div className="flex flex-1 flex-col gap-2">
              <div className="flex items-center gap-2">
                <span className="text-text-subtle text-2xs w-10 tracking-wider uppercase">
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
                <span className="text-text-subtle text-2xs inline-flex w-10 items-center gap-1 tracking-wider uppercase">
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

              {streamError && (
                <span className="text-destructive text-xs">{streamError}</span>
              )}
            </div>
          </div>
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
  containerRef: React.Ref<HTMLDivElement>;
  ready: boolean;
  testId: string;
  onPointerDown?: (e: React.PointerEvent<HTMLDivElement>) => void;
  onPointerMove?: (e: React.PointerEvent<HTMLDivElement>) => void;
  onPointerUp?: (e: React.PointerEvent<HTMLDivElement>) => void;
  onPointerCancel?: (e: React.PointerEvent<HTMLDivElement>) => void;
  empty?: boolean;
  emptyLabel?: string;
}

/** A waveform container with a centred vertical playhead overlay. The
 *  WaveSurfer instance is mounted into ``containerRef`` by the parent;
 *  this just owns the framing and the playhead line so both strips
 *  look identical and so the parent's drag handlers get a clean
 *  pointer-event target. */
function WaveformStrip({
  containerRef,
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
      className="border-border bg-surface-2 relative h-20 w-full min-w-0 overflow-hidden rounded-md border"
      data-testid={testId}
    >
      {empty ? (
        <div className="text-text-subtle absolute inset-0 grid place-items-center text-xs">
          {emptyLabel}
        </div>
      ) : (
        <>
          <div
            ref={containerRef}
            className="h-full w-full overflow-hidden"
            // ``touchAction: none`` keeps the browser from scrolling
            // the page when the user drag-nudges with a touch device.
            style={{ touchAction: "none" }}
          />
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
          {/* Pointer overlay — sits on top of WaveSurfer (whose shadow-DOM
              scroll container otherwise wins the hit-test) so the drag
              captures pointer events instead of WaveSurfer's own scroll. */}
          {onPointerDown && (
            <div
              className="absolute inset-0 z-10 cursor-ew-resize"
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
