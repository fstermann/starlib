"use client";

import { Music } from "lucide-react";
import { useEffect, useState } from "react";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { api, type TrackInfo } from "@/lib/api";
import {
  formatClock,
  type SoundCloudOrigin,
  type TrackBreakdown,
  type TrackSource,
} from "@/lib/track-breakdown";

import { GridEditor } from "./grid-editor";
import { fileStem } from "./track-picker";

/** Cover, title and artist, then the track's measured tempo, key and length. */
export function TrackHeader({
  source,
  result,
  onRemeasure,
}: {
  source: TrackSource;
  result: TrackBreakdown;
  onRemeasure: () => void;
}) {
  const { grid, tonal, duration_s } = result.features;
  const bass = tonal.bass_peaks[0];
  return (
    <div
      className="flex flex-wrap items-center gap-x-6 gap-y-2"
      data-testid="track-header"
    >
      {result.soundcloud ? (
        <SoundCloudIdentity track={result.soundcloud} />
      ) : (
        source.kind === "file" && <FileIdentity path={source.path} />
      )}
      <Stat
        label="Tempo"
        value={`${Number(grid.bpm.toFixed(2))} BPM`}
        testId="track-bpm"
      />
      <Stat
        label="Root"
        value={tonal.root ?? "–"}
        hint={bass && `Bass ${bass.note} at ${bass.hz.toFixed(1)} Hz`}
        testId="track-root"
      />
      <GridEditor
        digest={result.digest}
        grid={grid}
        edited={result.grid_edited}
        onRemeasure={onRemeasure}
      >
        <Stat label="Bars" value={String(grid.n_bars)} />
      </GridEditor>
      <Stat label="Length" value={formatClock(duration_s)} />
    </div>
  );
}

function artistText(artist: TrackInfo["artist"]): string | null {
  if (!artist) return null;
  return Array.isArray(artist) ? artist.join(", ") : artist;
}

function SoundCloudIdentity({ track }: { track: SoundCloudOrigin }) {
  return (
    <Identity
      title={track.title ?? `SoundCloud track ${track.id}`}
      artist={track.artist}
      artworkUrl={track.artwork_url && api.proxyImageUrl(track.artwork_url)}
    />
  );
}

function FileIdentity({ path }: { path: string }) {
  const [info, setInfo] = useState<TrackInfo | null>(null);
  useEffect(() => {
    let live = true;
    api
      .getTrackInfo(path)
      .then((next) => live && setInfo(next))
      .catch(() => live && setInfo(null));
    return () => {
      live = false;
    };
  }, [path]);

  return (
    <Identity
      title={info?.title || fileStem(path)}
      artist={artistText(info?.artist)}
      artworkUrl={info?.has_artwork ? api.getArtworkUrl(path) : null}
    />
  );
}

function Identity({
  title,
  artist,
  artworkUrl,
}: {
  title: string;
  artist: string | null;
  artworkUrl: string | null;
}) {
  return (
    <div className="flex max-w-80 min-w-0 items-center gap-3 border-r border-[var(--border)] pr-6">
      <div className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-md bg-[var(--surface-3)]">
        {artworkUrl ? (
          <img
            src={artworkUrl}
            alt=""
            className="size-10 object-cover"
            data-testid="track-cover"
          />
        ) : (
          <Music className="size-4 text-[var(--text-muted)]" aria-hidden />
        )}
      </div>
      <div className="flex min-w-0 flex-col">
        <span
          className="truncate text-sm text-[var(--text)]"
          data-testid="track-title"
        >
          {title}
        </span>
        {artist && (
          <span
            className="truncate text-xs text-[var(--text-muted)]"
            data-testid="track-artist"
          >
            {artist}
          </span>
        )}
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
  testId,
}: {
  label: string;
  value: string;
  hint?: string;
  testId?: string;
}) {
  const stat = (
    <div className="flex items-baseline gap-1.5">
      <span className="text-xs text-[var(--text-muted)]">{label}</span>
      <span
        className="text-lg text-[var(--text)] tabular-nums"
        data-testid={testId}
      >
        {value}
      </span>
    </div>
  );
  if (!hint) return stat;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{stat}</TooltipTrigger>
      <TooltipContent data-testid={testId && `${testId}-hint`}>
        {hint}
      </TooltipContent>
    </Tooltip>
  );
}
