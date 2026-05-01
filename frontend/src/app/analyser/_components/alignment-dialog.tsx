"use client";

import Hls from "hls.js";
import { Pause, Play } from "lucide-react";
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
import { Slider } from "@/components/ui/slider";
import {
  formatTimecode,
  jobAudioUrl,
  pitchSpeedRatio,
  type TrackTimelineEntry,
  updateTrack,
} from "@/lib/analyser";
import { getCachedSoundcloudStreamUrl } from "@/lib/soundcloud-cache";

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
  /** Called after save with the new ``start_s`` so the parent can refresh
   *  the snapshot without waiting for the next SSE event. */
  onSaved?: (newStartS: number) => void;
}

const NUDGE_RANGE_S = 30;
const NUDGE_STEP_S = 0.05;
/** Pixels per second of mix time. Drives the zoom; same density on both
 *  waveforms so 1 px = 1/PX_PER_S of mix time on either strip. The SC
 *  waveform compensates for pitch by using a smaller px-per-original-s
 *  internally — see ``scPxPerSec`` below. */
const PX_PER_S = 40;

/** A/B comparison + manual alignment for a Shazam-identified track.
 *
 *  Renders the cached set audio and the original SoundCloud track as
 *  two stacked WaveSurfer waveforms, each centred on the proposed
 *  alignment point with a vertical playhead. The user drags the
 *  original waveform horizontally (or nudges via the slider / arrow
 *  keys) until kicks line up by eye, then saves. The original plays at
 *  ``1 / pitchSpeedRatio(pitch_offset)`` so its tempo matches the mix's
 *  by ear too.
 *
 *  Auto cross-correlation is intentionally still out of scope — manual
 *  alignment first, server-side correlation as a follow-up. */
export function AlignmentDialog({
  open,
  onOpenChange,
  jobId,
  track,
  soundcloudIdOverride,
  onSaved,
}: AlignmentDialogProps) {
  const soundcloudId = soundcloudIdOverride ?? track.soundcloud_id ?? null;

  const setContainerRef = useRef<HTMLDivElement | null>(null);
  const scContainerRef = useRef<HTMLDivElement | null>(null);
  const setWsRef = useRef<WaveSurferType | null>(null);
  const scWsRef = useRef<WaveSurferType | null>(null);
  const setAudioRef = useRef<HTMLAudioElement | null>(null);
  const scAudioRef = useRef<HTMLAudioElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);

  const [streamUrl, setStreamUrl] = useState<string | null>(null);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [setReady, setSetReady] = useState(false);
  const [scReady, setScReady] = useState(false);

  const [isPlaying, setIsPlaying] = useState(false);
  const [offsetS, setOffsetS] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const newStartS = Math.max(0, track.start_s + offsetS);
  const speedRatio =
    track.pitch_offset != null ? pitchSpeedRatio(track.pitch_offset) : 1;
  // SC plays at ``1/speedRatio`` to match set tempo. Visually we
  // compensate by stretching the SC waveform so 1 px = same set-time
  // as the set strip. Internal px-per-original-second is reduced
  // accordingly.
  const scPxPerSec = PX_PER_S * speedRatio;

  // Reset offset whenever the dialog opens against a new track.
  useEffect(() => {
    if (open) {
      setOffsetS(0);
      setSaveError(null);
    }
  }, [open, track.id]);

  // Resolve SC stream URL when the dialog opens.
  useEffect(() => {
    if (!open || !soundcloudId) {
      setStreamUrl(null);
      setStreamError(null);
      return;
    }
    let cancelled = false;
    setStreamError(null);
    getCachedSoundcloudStreamUrl(soundcloudId)
      .then((url) => {
        if (!cancelled) setStreamUrl(url);
      })
      .catch((err) => {
        if (!cancelled) {
          setStreamError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, soundcloudId]);

  // Mount the SET waveform when the dialog opens. We use WaveSurfer with
  // a media element so playback + scroll are decoupled from each other.
  useEffect(() => {
    if (!open) return;
    const container = setContainerRef.current;
    if (!container) return;
    let cancelled = false;
    let teardown: (() => void) | null = null;
    setSetReady(false);
    void (async () => {
      const { default: WaveSurfer } = await import("wavesurfer.js");
      if (cancelled || !container) return;
      const audio = new Audio(jobAudioUrl(jobId));
      audio.preload = "auto";
      setAudioRef.current = audio;
      const cs = getComputedStyle(document.documentElement);
      const colour = (token: string, fallback: string) => {
        const v = cs.getPropertyValue(token).trim();
        return v.length > 0 ? v : fallback;
      };
      const ws = WaveSurfer.create({
        container,
        media: audio,
        height: 80,
        waveColor: colour("--color-text-subtle", "#888"),
        progressColor: colour("--color-brand", "#a0e060"),
        cursorColor: colour("--color-brand-active", "#84c441"),
        cursorWidth: 0,
        barWidth: 2,
        barGap: 1,
        barRadius: 1,
        normalize: true,
        minPxPerSec: PX_PER_S,
        autoScroll: false,
        interact: true,
      });
      setWsRef.current = ws;
      ws.on("ready", () => {
        if (cancelled) return;
        setSetReady(true);
      });
      ws.on("play", () => setIsPlaying(true));
      ws.on("pause", () => setIsPlaying(false));
      ws.on("finish", () => setIsPlaying(false));
      teardown = () => {
        try {
          ws.destroy();
        } catch {
          /* already torn down */
        }
        audio.pause();
        audio.src = "";
      };
    })();
    return () => {
      cancelled = true;
      teardown?.();
      setWsRef.current = null;
      setAudioRef.current = null;
    };
  }, [open, jobId]);

  // Mount the SC original waveform when the stream URL resolves.
  useEffect(() => {
    if (!open) return;
    const container = scContainerRef.current;
    if (!container || !streamUrl) return;
    let cancelled = false;
    let teardown: (() => void) | null = null;
    setScReady(false);
    void (async () => {
      const { default: WaveSurfer } = await import("wavesurfer.js");
      if (cancelled || !container) return;
      const audio = new Audio();
      audio.preload = "auto";
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
      const cs = getComputedStyle(document.documentElement);
      const colour = (token: string, fallback: string) => {
        const v = cs.getPropertyValue(token).trim();
        return v.length > 0 ? v : fallback;
      };
      const ws = WaveSurfer.create({
        container,
        media: audio,
        height: 80,
        waveColor: colour("--color-text-subtle", "#888"),
        progressColor: colour("--color-brand", "#a0e060"),
        cursorColor: colour("--color-brand-active", "#84c441"),
        cursorWidth: 0,
        barWidth: 2,
        barGap: 1,
        barRadius: 1,
        normalize: true,
        // Visually 1 px = 1/PX_PER_S of *set* time for both strips,
        // achieved by scaling the SC's px-per-second by the speed
        // ratio. Listening playback rate is set separately on the audio
        // element so the SC plays at set tempo by ear too.
        minPxPerSec: scPxPerSec,
        autoScroll: false,
        interact: true,
      });
      scWsRef.current = ws;
      ws.on("ready", () => {
        if (cancelled) return;
        setScReady(true);
      });
      teardown = () => {
        try {
          ws.destroy();
        } catch {
          /* already torn down */
        }
        hlsRef.current?.destroy();
        hlsRef.current = null;
        audio.pause();
        audio.src = "";
      };
    })();
    return () => {
      cancelled = true;
      teardown?.();
      scWsRef.current = null;
      scAudioRef.current = null;
    };
  }, [open, streamUrl, scPxPerSec]);

  // Pitch-match: the SC track plays back faster or slower so the
  // listener hears it at the same tempo as the mix.
  useEffect(() => {
    const audio = scAudioRef.current;
    if (!audio) return;
    audio.playbackRate = 1 / speedRatio;
  }, [speedRatio, scReady]);

  // Re-centre both waveform scrolls whenever the alignment point
  // moves. Set strip centres on ``newStartS``, SC strip centres on
  // ``0`` — so the playheads on both strips fall on the same vertical
  // axis (the centre of each container).
  useEffect(() => {
    const setContainer = setContainerRef.current;
    const scContainer = scContainerRef.current;
    if (setContainer && setReady) {
      const halfWidth = setContainer.clientWidth / 2;
      setContainer.scrollLeft = Math.max(
        0,
        newStartS * PX_PER_S - halfWidth,
      );
    }
    if (scContainer && scReady) {
      const halfWidth = scContainer.clientWidth / 2;
      // The SC playhead at the alignment point starts at the original's
      // t=0 — that's the assumption. ``offsetS`` shifts the visual
      // window so the user can find a different sync point in the
      // original (e.g. drop is 8 s into the released version).
      scContainer.scrollLeft = Math.max(
        0,
        Math.max(0, -offsetS) * scPxPerSec - halfWidth,
      );
    }
  }, [newStartS, offsetS, scPxPerSec, setReady, scReady]);

  // Drag the SC waveform horizontally to nudge offset. Pointer-based
  // so it works for trackpad + touch alike. dx in pixels translates to
  // dt in *set* seconds via PX_PER_S — using set time on both strips
  // means a 100 px drag means the same thing visually on either side.
  const dragRef = useRef<{ startX: number; startOffset: number } | null>(null);
  const onScPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      dragRef.current = { startX: e.clientX, startOffset: offsetS };
      (e.target as HTMLDivElement).setPointerCapture(e.pointerId);
    },
    [offsetS],
  );
  const onScPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag) return;
      const dx = e.clientX - drag.startX;
      // Dragging right = the SC strip moves right, which means the
      // user wants the original to align to a *later* mix position →
      // mix start time decreases → offsetS decreases.
      const dt = -dx / PX_PER_S;
      const next = Math.max(
        -NUDGE_RANGE_S,
        Math.min(NUDGE_RANGE_S, drag.startOffset + dt),
      );
      setOffsetS(next);
    },
    [],
  );
  const onScPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      dragRef.current = null;
      (e.target as HTMLDivElement).releasePointerCapture(e.pointerId);
    },
    [],
  );

  // Stop both players when the dialog closes.
  useEffect(() => {
    if (open) return;
    setAudioRef.current?.pause();
    scAudioRef.current?.pause();
    setIsPlaying(false);
  }, [open]);

  const seekToStart = useCallback(() => {
    const setAudio = setAudioRef.current;
    const scAudio = scAudioRef.current;
    if (setAudio) {
      setAudio.currentTime = newStartS;
    }
    if (scAudio) {
      scAudio.currentTime = 0;
    }
  }, [newStartS]);

  const togglePlay = useCallback(async () => {
    const setAudio = setAudioRef.current;
    if (!setAudio) return;
    const scAudio = scAudioRef.current;
    if (isPlaying) {
      setAudio.pause();
      scAudio?.pause();
      setIsPlaying(false);
      return;
    }
    seekToStart();
    try {
      await setAudio.play();
      if (scAudio) {
        scAudio.playbackRate = 1 / speedRatio;
        await scAudio.play();
      }
      setIsPlaying(true);
    } catch (err) {
      console.warn("alignment: playback failed", err);
      setIsPlaying(false);
    }
  }, [isPlaying, seekToStart, speedRatio]);

  const handleSave = useCallback(async () => {
    if (saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      await updateTrack(jobId, track.id, { start_s: newStartS });
      onSaved?.(newStartS);
      onOpenChange(false);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [jobId, newStartS, onOpenChange, onSaved, saving, track.id]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-2xl"
        data-testid="alignment-dialog"
      >
        <DialogHeader>
          <DialogTitle>Align &ldquo;{track.title}&rdquo;</DialogTitle>
          <DialogDescription>
            Line up the kicks: the mix on top, the original below. Drag
            the original to nudge, or use the slider. Save when they
            match.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="border-border bg-surface-2 flex items-baseline justify-between gap-3 rounded-lg border px-3 py-2">
            <div className="flex flex-col">
              <span className="text-text-subtle text-2xs uppercase tracking-wider">
                Mix start
              </span>
              <span
                className="text-text font-mono text-xl tabular-nums"
                data-testid="alignment-new-start"
              >
                {formatTimecode(newStartS)}
              </span>
            </div>
            <div className="text-text-subtle flex flex-col items-end text-xs">
              <span>
                {offsetS >= 0 ? "+" : ""}
                {offsetS.toFixed(2)} s vs. detected ({formatTimecode(track.start_s)})
              </span>
              <span>
                {track.pitch_offset != null
                  ? `Original at ${(1 / speedRatio).toFixed(3)}× ${
                      track.set_bpm != null
                        ? `(matches ${track.set_bpm.toFixed(0)} BPM)`
                        : ""
                    }`
                  : "Native tempo (no pitch info on this row)"}
              </span>
            </div>
          </div>

          {/* Set waveform — top strip, centred on newStartS. */}
          <div className="flex flex-col gap-1">
            <div className="text-text-muted text-2xs uppercase tracking-wider">
              Mix
            </div>
            <WaveformStrip
              containerRef={setContainerRef}
              ready={setReady}
              testId="alignment-set-strip"
            />
          </div>

          {/* SC waveform — bottom strip, drag to nudge. */}
          <div className="flex flex-col gap-1">
            <div className="flex items-baseline justify-between">
              <span className="text-text-muted text-2xs uppercase tracking-wider">
                Original
              </span>
              <span className="text-text-subtle text-2xs">
                drag horizontally to nudge
              </span>
            </div>
            <WaveformStrip
              containerRef={scContainerRef}
              ready={scReady}
              testId="alignment-sc-strip"
              onPointerDown={onScPointerDown}
              onPointerMove={onScPointerMove}
              onPointerUp={onScPointerUp}
              onPointerCancel={onScPointerUp}
              empty={!soundcloudId}
              emptyLabel="No SoundCloud match — mix-only alignment."
            />
          </div>

          <div className="flex flex-col gap-1">
            <label
              htmlFor="alignment-offset"
              className="text-text-muted text-2xs uppercase tracking-wider"
            >
              Nudge ±{NUDGE_RANGE_S} s
            </label>
            <Slider
              id="alignment-offset"
              data-testid="alignment-offset-slider"
              value={[offsetS]}
              min={-NUDGE_RANGE_S}
              max={NUDGE_RANGE_S}
              step={NUDGE_STEP_S}
              onValueChange={(values) => setOffsetS(values[0] ?? 0)}
            />
          </div>

          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={togglePlay}
              disabled={!setReady}
              data-testid="alignment-play-toggle"
            >
              {isPlaying ? (
                <>
                  <Pause className="size-3.5" /> Pause
                </>
              ) : (
                <>
                  <Play className="size-3.5" /> Play A/B
                </>
              )}
            </Button>
            {streamError && (
              <span className="text-destructive text-xs">{streamError}</span>
            )}
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
            onClick={handleSave}
            disabled={saving || offsetS === 0}
            data-testid="alignment-save"
          >
            {saving ? "Saving…" : "Save alignment"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface WaveformStripProps {
  containerRef: React.RefObject<HTMLDivElement | null>;
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
      className="border-border bg-surface-2 relative h-20 overflow-hidden rounded-md border"
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
            className="h-full overflow-hidden"
            // ``touchAction: none`` keeps the browser from scrolling
            // the page when the user drag-nudges with a touch device.
            style={{ touchAction: "none" }}
          />
          {!ready && (
            <div className="text-text-subtle absolute inset-0 grid place-items-center text-xs">
              loading…
            </div>
          )}
          {/* Centred playhead — on both strips this column corresponds
              to the same set-time, so when bars line up across both
              strips at the centre, the kicks are aligned. */}
          <div
            aria-hidden
            className="bg-brand pointer-events-none absolute top-0 bottom-0 left-1/2 w-px"
          />
          {/* Pointer overlay — only present when a drag handler is
              wired (the SC strip). Sits on top of WaveSurfer so the
              drag captures pointer events instead of WaveSurfer's
              own click-to-seek. */}
          {onPointerDown && (
            <div
              className="absolute inset-0 cursor-ew-resize"
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
