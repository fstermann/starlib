"use client";

import { ExternalLink, Loader2, Pause, Play } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { SoundcloudLikeButton } from "@/components/soundcloud-like-button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { formatTimecode } from "@/lib/analyser";
import { claimPlayback, releasePlayback } from "@/lib/exclusive-audio";
import {
  getCachedSoundcloudPeaks,
  getCachedSoundcloudStreamUrl,
} from "@/lib/soundcloud-cache";

/** Where a preview's audio comes from. ``url`` is a ready-to-play clip
 *  (Shazam's 30 s m4a); ``soundcloud`` resolves an HLS stream on demand. */
export type PreviewSource =
  | { kind: "url"; url: string }
  | {
      kind: "soundcloud";
      trackId: number;
      waveformUrl?: string | null;
      durationS?: number | null;
    };

const SLOT = "analyser-preview";
const NUM_PEAKS = 200;
// Neutral waveform silhouette shown when real peaks aren't available —
// Shazam clips ship none and decoding them cross-origin is slow /
// CORS-blocked. A gently-varying envelope reads as "audio" (with a live
// progress cursor) instead of an endless spinner or a solid block.
const PLACEHOLDER_PEAKS = Array.from({ length: NUM_PEAKS }, (_, i) => {
  const env = Math.abs(Math.sin(i * 0.21)) * (0.55 + 0.45 * Math.sin(i * 0.06));
  return 0.25 + 0.6 * Math.abs(env);
});

interface WaveSurferLike {
  destroy(): void;
}

function colour(token: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue(token)
    .trim();
  return v.length > 0 ? v : fallback;
}

/** Anchored waveform popover for in-section preview playback.
 *
 *  Keeps "preview" self-contained — Shazam clips and SoundCloud streams
 *  play here on their own little WaveSurfer instead of taking over the
 *  global player bar. Playback is driven by a media element so it starts
 *  on ``canplay`` (not after a full decode), and the waveform paints from
 *  precomputed peaks where available. Plugs into the exclusive-audio
 *  arbiter so starting a preview pauses the set / global player. The
 *  ``children`` button is the trigger; the parent owns ``open`` so only
 *  one preview is live at a time. */
export function PreviewPopover({
  open,
  onOpenChange,
  source,
  title,
  subtitle,
  children,
  contentTestId,
  openUrl,
  openLabel,
  openTestId,
  likeUrn,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  source: PreviewSource | null;
  title: string;
  subtitle?: string | null;
  children: React.ReactNode;
  contentTestId?: string;
  /** "Open on Shazam" / "Open on SoundCloud" external link target. Null
   *  hides the link (e.g. a SoundCloud preview that hasn't resolved). */
  openUrl?: string | null;
  openLabel?: string;
  openTestId?: string;
  /** When set, render a SoundCloud like button acting on this track urn
   *  (``soundcloud:tracks:<id>``). SoundCloud previews only. */
  likeUrn?: string | null;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const wsRef = useRef<WaveSurferLike | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [progressS, setProgressS] = useState(0);
  const [durationS, setDurationS] = useState(0);

  // Read the live source from a ref so the WaveSurfer effect can depend
  // on a stable primitive key (not the freshly-built object each render)
  // and not re-create the instance on every parent re-render.
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const sourceKey =
    source == null
      ? null
      : source.kind === "url"
        ? source.url
        : `sc:${source.trackId}`;

  useEffect(() => {
    // NB: don't gate on ``containerRef.current`` — the popover content is
    // portaled and the ref can be unset on the commit this effect first
    // runs, which would bail permanently (deps don't re-fire) and leave
    // the clip silent. Audio playback needs no container; WaveSurfer
    // (display only) checks for it at create time.
    if (!open || sourceKey == null) return;
    const src = sourceRef.current;
    if (src == null) return;
    let cancelled = false;
    let teardown: (() => void) | null = null;
    setReady(false);
    setError(null);
    setPlaying(false);
    setProgressS(0);
    setDurationS(src.kind === "soundcloud" ? (src.durationS ?? 0) : 0);

    void (async () => {
      try {
        const audio = new Audio();
        audio.preload = "auto";
        // Attach to the DOM (hidden). A detached media element doesn't
        // reliably fire ``loadedmetadata`` / ``canplay`` in the Tauri
        // webview, which would leave the clip silent and the waveform
        // unpainted (WaveSurfer renders peaks once the media reports a
        // duration). Mirrors the global WaveformPlayer.
        audio.hidden = true;
        document.body.appendChild(audio);
        let hls: { destroy(): void } | null = null;
        let peaks: number[] | null = null;

        if (src.kind === "url") {
          audio.src = src.url;
        } else {
          const streamUrl = await getCachedSoundcloudStreamUrl(src.trackId);
          if (cancelled) return;
          if (streamUrl.split("?")[0].endsWith(".m3u8")) {
            audio.crossOrigin = "anonymous";
            const { default: Hls } = await import("hls.js");
            if (cancelled) return;
            if (Hls.isSupported()) {
              const inst = new Hls();
              inst.loadSource(streamUrl);
              inst.attachMedia(audio);
              hls = inst;
            } else {
              audio.src = streamUrl;
            }
          } else {
            audio.src = streamUrl;
          }
          peaks = src.waveformUrl
            ? await getCachedSoundcloudPeaks(src.waveformUrl, NUM_PEAKS)
            : null;
          if (cancelled) return;
        }
        audioRef.current = audio;

        // Playback is driven by the media element directly — NOT through
        // WaveSurfer. WS with a media element + peaks but no known
        // duration (Shazam clips) silently never starts; the element
        // always plays. WS below is display-only and can't block sound.
        const tryPlay = () => {
          if (!cancelled) void audio.play().catch(() => {});
        };
        const onPlaying = () => {
          if (cancelled) return;
          setReady(true);
          setPlaying(true);
          claimPlayback(SLOT, () => audio.pause());
        };
        const onPause = () => {
          if (cancelled) return;
          setPlaying(false);
          releasePlayback(SLOT);
        };
        const onTime = () => setProgressS(audio.currentTime);
        const onMeta = () => {
          if (cancelled) return;
          if (Number.isFinite(audio.duration) && audio.duration > 0) {
            setDurationS(audio.duration);
          }
        };
        const onErr = () => {
          if (!cancelled) setError("preview failed to load");
        };
        audio.addEventListener("playing", onPlaying);
        audio.addEventListener("pause", onPause);
        audio.addEventListener("ended", onPause);
        audio.addEventListener("timeupdate", onTime);
        audio.addEventListener("loadedmetadata", onMeta);
        audio.addEventListener("error", onErr);
        // Enable the toggle now (manual fallback if autoplay is blocked)
        // and kick playback — immediately if already buffered, else once
        // the element can play. Guarding on ``readyState`` avoids missing
        // a ``canplay`` that fired during the awaits above.
        setReady(true);
        if (audio.readyState >= 2) tryPlay();
        else audio.addEventListener("canplay", tryPlay, { once: true });

        // Set teardown now — before the WS work, which may bail or never
        // mount a container. Playback is already live, so cleanup must be
        // wired regardless of whether a waveform ever renders.
        teardown = () => {
          audio.removeEventListener("playing", onPlaying);
          audio.removeEventListener("pause", onPause);
          audio.removeEventListener("ended", onPause);
          audio.removeEventListener("timeupdate", onTime);
          audio.removeEventListener("loadedmetadata", onMeta);
          audio.removeEventListener("error", onErr);
          audio.removeEventListener("canplay", tryPlay);
          try {
            wsRef.current?.destroy();
          } catch {
            // already gone — fine
          }
          hls?.destroy();
          audio.pause();
          audio.src = "";
          audio.remove();
          audioRef.current = null;
          releasePlayback(SLOT);
        };

        // WaveSurfer — display only. Needs a finite duration to lay out
        // peaks; SC carries one, Shazam clips report it via metadata, so
        // create lazily once a duration is known.
        const { default: WaveSurfer } = await import("wavesurfer.js");
        if (cancelled) return;
        const mkWs = (duration: number) => {
          if (cancelled || wsRef.current || !containerRef.current) return;
          wsRef.current = WaveSurfer.create({
            container: containerRef.current,
            height: 48,
            waveColor: colour("--color-text-subtle", "#888"),
            progressColor: colour("--color-brand", "#a0e060"),
            cursorColor: colour("--color-brand-active", "#84c441"),
            cursorWidth: 1,
            barWidth: 2,
            barGap: 1,
            barRadius: 1,
            normalize: true,
            media: audio,
            peaks: [peaks ?? PLACEHOLDER_PEAKS],
            duration,
          }) as unknown as WaveSurferLike;
        };
        const known =
          src.kind === "soundcloud" && src.durationS
            ? src.durationS
            : Number.isFinite(audio.duration) && audio.duration > 0
              ? audio.duration
              : 0;
        if (known > 0) mkWs(known);
        else
          audio.addEventListener("loadedmetadata", () => mkWs(audio.duration), {
            once: true,
          });
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    })();

    return () => {
      cancelled = true;
      teardown?.();
      wsRef.current = null;
    };
  }, [open, sourceKey]);

  const toggle = () => {
    const audio = audioRef.current;
    if (!audio || !ready) return;
    if (audio.paused) void audio.play().catch(() => {});
    else audio.pause();
  };

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-72 p-3"
        data-testid={contentTestId}
      >
        <div className="mb-2 min-w-0">
          <div className="text-text truncate text-sm font-medium" title={title}>
            {title}
          </div>
          {subtitle && (
            <div className="text-text-muted truncate text-xs">{subtitle}</div>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={toggle}
            disabled={!ready}
            aria-label={playing ? "Pause preview" : "Play preview"}
            className="bg-brand text-text-on-accent hover:bg-brand-hover active:bg-brand-active grid size-8 shrink-0 cursor-pointer place-items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50"
            data-testid="preview-toggle"
          >
            {!ready && !error ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : playing ? (
              <Pause className="size-3.5" />
            ) : (
              <Play className="size-3.5 translate-x-px" />
            )}
          </button>
          <div
            ref={containerRef}
            className="min-w-0 flex-1"
            data-testid="preview-waveform"
          />
        </div>
        <div className="mt-2 flex items-center justify-between gap-2">
          <div className="flex items-center gap-1">
            {openUrl && (
              <a
                href={openUrl}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={openLabel}
                title={openLabel}
                data-testid={openTestId}
                className="text-text-subtle hover:text-text grid size-6 place-items-center rounded transition-colors"
              >
                <ExternalLink className="size-3.5" />
              </a>
            )}
            {likeUrn && (
              <SoundcloudLikeButton trackUrn={likeUrn} initialLiked={false} />
            )}
          </div>
          {error ? (
            <span
              className="text-destructive text-xs"
              data-testid="preview-error"
            >
              {error}
            </span>
          ) : (
            <span className="text-text-subtle text-xs tabular-nums">
              {formatTimecode(progressS)} / {formatTimecode(durationS)}
            </span>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
