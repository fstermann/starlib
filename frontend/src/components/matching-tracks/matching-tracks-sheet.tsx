"use client";

import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronDown, ListMusic, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  DROP_BLOCKER,
  useExternalTrackDrag,
} from "@/app/library/rekordbox-playlist-dnd";
import {
  rekordboxPlayerTrack,
  useRekordboxCollection,
  useRekordboxPlaylists,
  useRekordboxPlaylistTracks,
  type RekordboxTrack,
} from "@/app/library/use-rekordbox";
import { CoverPlayButton } from "@/components/cover-play-button";
import { LogoSpinner } from "@/components/logo-spinner";
import { TrackQueueMenu } from "@/components/track-queue-menu";
import { Checkbox } from "@/components/ui/checkbox";
import { ContextMenuItem } from "@/components/ui/context-menu";
import { MotionMultiselect } from "@/components/ui/motion-multiselect";
import { NumberInput } from "@/components/ui/number-input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import {
  DEFAULT_KEY_RULES,
  DETUNE_LIMIT_SEMITONES,
  harmonicMatch,
  KEY_RULES,
  tempoShift,
  toCamelot,
  type HarmonicMatch,
  type KeyRule,
} from "@/lib/harmonic-match";
import { usePlayer, type PlayerTrack } from "@/lib/player-context";
import { getRaw, setRaw } from "@/lib/settings";
import { cn } from "@/lib/utils";
import { transposeKey } from "@/lib/waveform-detail";

import type {
  MatchingPlaylistContext,
  MatchingSource,
} from "./matching-tracks-provider";

const PREFS_KEY = "matching-tracks.prefs";
const CURRENT_SCOPE = "current";
const COLLECTION_SCOPE = "collection";
/** Default BPM range around the reference tempo. */
const BPM_SPAN = 5;
const ROW_HEIGHT = 40;
const HEADER_HEIGHT = 28;

interface Prefs {
  rules: KeyRule[];
  keyLock: boolean;
  /** `current`, `collection`, or a Rekordbox playlist id. */
  scope: string;
}

const DEFAULT_PREFS: Prefs = {
  rules: DEFAULT_KEY_RULES,
  keyLock: false,
  scope: COLLECTION_SCOPE,
};

const RULE_RANK = new Map(KEY_RULES.map((r, i) => [r.id, i]));

interface Match {
  track: RekordboxTrack;
  match: HarmonicMatch | null;
  inPlaylist: boolean;
}

type ListRow =
  | { kind: "header"; label: string; first: boolean }
  | { kind: "track"; item: Match };

function usePrefs(): [Prefs, (patch: Partial<Prefs>) => void] {
  const [prefs, setPrefs] = useState(DEFAULT_PREFS);
  useEffect(() => {
    getRaw<Prefs>(PREFS_KEY, DEFAULT_PREFS)
      .then((p) => setPrefs({ ...DEFAULT_PREFS, ...p }))
      .catch(() => {});
  }, []);
  const update = (patch: Partial<Prefs>) =>
    setPrefs((prev) => {
      const next = { ...prev, ...patch };
      void setRaw(PREFS_KEY, next);
      return next;
    });
  return [prefs, update];
}

function bpmRange(refBpm: number | null): [string, string] {
  if (!refBpm) return ["", ""];
  const center = Math.round(refBpm);
  return [String(center - BPM_SPAN), String(center + BPM_SPAN)];
}

function compareMatches(a: Match, b: Match, sourceBpm: number | null) {
  if (a.inPlaylist !== b.inPlaylist) return a.inPlaylist ? -1 : 1;
  const rank = (m: Match) =>
    m.match ? (RULE_RANK.get(m.match.rule) ?? 99) : 99;
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  const detuned = (m: Match) =>
    (m.match?.detune ?? 0) > DETUNE_LIMIT_SEMITONES ? 1 : 0;
  if (detuned(a) !== detuned(b)) return detuned(a) - detuned(b);
  const dist = (m: Match) =>
    sourceBpm && m.track.bpm ? Math.abs(m.track.bpm - sourceBpm) : Infinity;
  return dist(a) - dist(b);
}

export function MatchingTracksSheet({
  open,
  onOpenChange,
  source,
  playlist,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  source: MatchingSource | null;
  playlist: MatchingPlaylistContext | null;
}) {
  const player = usePlayer();
  const [prefs, updatePrefs] = usePrefs();
  const device = source?.device ?? null;

  // Fetch lazily, then keep the data across closes so reopening is instant.
  const [loadData, setLoadData] = useState(false);
  if (open && !loadData) setLoadData(true);
  const collection = useRekordboxCollection(loadData, device);
  const playlists = useRekordboxPlaylists(loadData, device);

  const current = playlist && playlist.device === device ? playlist : null;
  const scope =
    prefs.scope === CURRENT_SCOPE && !current ? COLLECTION_SCOPE : prefs.scope;
  const scopedPlaylistId =
    scope !== CURRENT_SCOPE && scope !== COLLECTION_SCOPE ? scope : null;
  const scoped = useRekordboxPlaylistTracks(
    loadData ? scopedPlaylistId : null,
    device,
  );
  const currentTracks = current?.tracks;
  const pool = useMemo(
    () =>
      scope === CURRENT_SCOPE
        ? (currentTracks ?? [])
        : scope === COLLECTION_SCOPE
          ? collection.data.tracks
          : scoped.data.tracks,
    [scope, currentTracks, collection.data.tracks, scoped.data.tracks],
  );
  const poolLoading =
    scope === COLLECTION_SCOPE
      ? collection.loading
      : scope !== CURRENT_SCOPE && scoped.loading;

  const sourceTrack = useMemo(() => {
    if (!source) return null;
    if ("track" in source) return source.track;
    return (
      collection.data.tracks.find((t) => t.file_path === source.filePath) ??
      null
    );
  }, [source, collection.data.tracks]);

  const refBpm = player.pitchEnabled
    ? player.targetBpm
    : (sourceTrack?.bpm ?? null);

  // Filters start fresh for each source track: any genre, BPM around it.
  const [genres, setGenres] = useState<string[]>([]);
  const [bpmMin, setBpmMin] = useState("");
  const [bpmMax, setBpmMax] = useState("");
  const [seededFor, setSeededFor] = useState<string | null>(null);
  if (sourceTrack && seededFor !== sourceTrack.id) {
    setSeededFor(sourceTrack.id);
    setGenres([]);
    const [min, max] = bpmRange(refBpm);
    setBpmMin(min);
    setBpmMax(max);
  }

  const sourceKeyKnown = !!toCamelot(sourceTrack?.key);
  const keyFilterOn = sourceKeyKnown && prefs.rules.length > 0;
  const pinPlaylist = !!current && scope !== CURRENT_SCOPE;

  const genreCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const t of pool)
      if (t.genre) counts[t.genre] = (counts[t.genre] ?? 0) + 1;
    return counts;
  }, [pool]);

  const matches = useMemo(() => {
    if (!sourceTrack) return [];
    const inPlaylist = new Set(current?.tracks.map((t) => t.id));
    const min = bpmMin === "" ? null : Number(bpmMin);
    const max = bpmMax === "" ? null : Number(bpmMax);
    const seen = new Set<string>([sourceTrack.id]);
    const out: Match[] = [];
    for (const t of pool) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      if (min != null && (t.bpm == null || t.bpm < min)) continue;
      if (max != null && (t.bpm == null || t.bpm > max)) continue;
      if (genres.length > 0 && !(t.genre && genres.includes(t.genre))) continue;
      const match = harmonicMatch(sourceTrack, t, prefs.keyLock);
      if (keyFilterOn && !(match && prefs.rules.includes(match.rule))) continue;
      out.push({
        track: t,
        match,
        inPlaylist: pinPlaylist && inPlaylist.has(t.id),
      });
    }
    return out.sort((a, b) => compareMatches(a, b, sourceTrack.bpm));
  }, [
    sourceTrack,
    current,
    pool,
    bpmMin,
    bpmMax,
    genres,
    prefs.keyLock,
    prefs.rules,
    keyFilterOn,
    pinPlaylist,
  ]);

  const rows = useMemo<ListRow[]>(() => {
    const pinned = matches.filter((m) => m.inPlaylist);
    if (pinned.length === 0)
      return matches.map((item) => ({ kind: "track", item }));
    const rest = matches.filter((m) => !m.inPlaylist);
    return [
      { kind: "header", label: `In ${current?.name}`, first: true },
      ...pinned.map((item) => ({ kind: "track" as const, item })),
      ...(rest.length > 0
        ? [{ kind: "header" as const, label: "Other tracks", first: false }]
        : []),
      ...rest.map((item) => ({ kind: "track" as const, item })),
    ];
  }, [matches, current?.name]);

  const sourceShift = Math.round(
    tempoShift(sourceTrack?.bpm ?? null, refBpm ?? 0, prefs.keyLock),
  );
  // Labelled like the player and key column: each track's own shift, rounded.
  const pitchOf = (t: RekordboxTrack) =>
    tempoShift(t.bpm, refBpm ?? 0, prefs.keyLock);

  const playable = matches
    .map((m) => rekordboxPlayerTrack(m.track, device ?? ""))
    .filter((t): t is PlayerTrack => t !== null);
  const play = (t: RekordboxTrack) => {
    const idx = playable.findIndex((p) => p.filePath === t.file_path);
    if (idx >= 0) player.playQueue(playable, idx);
  };

  // State, not a ref: the sheet's content unmounts on close, and the
  // virtualizer only sees the remounted element if attaching it re-renders.
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollEl,
    estimateSize: (i) =>
      rows[i].kind === "header" ? HEADER_HEIGHT : ROW_HEIGHT,
    overscan: 8,
  });

  const scopablePlaylists = playlists.data.playlists
    .filter((p) => !p.is_folder)
    .sort((a, b) => a.name.localeCompare(b.name));

  return (
    // Non-modal so the playlist behind stays usable (reorder while browsing).
    <Sheet open={open} onOpenChange={onOpenChange} modal={false}>
      <SheetContent
        {...DROP_BLOCKER}
        side="right"
        data-testid="matching-tracks-panel"
        className="w-[28rem] max-w-[90vw] gap-0"
        onInteractOutside={(e) => e.preventDefault()}
      >
        <SheetHeader className="pb-3">
          <SheetTitle>Matching tracks</SheetTitle>
          <SheetDescription asChild>
            <div data-testid="matching-tracks-source" className="text-xs">
              {sourceTrack ? (
                <SourceSummary
                  track={sourceTrack}
                  refBpm={refBpm}
                  sourceShift={sourceShift}
                />
              ) : collection.loading || !collection.loaded ? (
                "Loading collection…"
              ) : (
                "This track isn't in your Rekordbox collection."
              )}
            </div>
          </SheetDescription>
        </SheetHeader>

        {sourceTrack && (
          <div className="border-border flex flex-col gap-3 border-y px-4 py-3">
            <FilterRow label="Key">
              <div className="flex flex-col gap-2">
                <ToggleGroup
                  type="multiple"
                  size="sm"
                  spacing={1}
                  value={prefs.rules}
                  onValueChange={(v) => updatePrefs({ rules: v as KeyRule[] })}
                  disabled={!sourceKeyKnown}
                  className="flex-wrap"
                >
                  {KEY_RULES.map((r) => (
                    <ToggleGroupItem
                      key={r.id}
                      value={r.id}
                      title={r.hint}
                      data-testid={`matching-rule-${r.id}`}
                      className="border-border cursor-pointer border px-2 data-[state=on]:border-[var(--border-brand)] data-[state=on]:bg-[var(--brand-soft)] data-[state=on]:text-[var(--text)]"
                    >
                      {r.label}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
                {!sourceKeyKnown ? (
                  <p className="text-2xs text-[var(--text-muted)]">
                    This track has no key, so key rules are off.
                  </p>
                ) : (
                  <label className="text-2xs flex cursor-pointer items-center gap-1.5 text-[var(--text-muted)]">
                    <Checkbox
                      checked={prefs.keyLock}
                      onCheckedChange={(c) =>
                        updatePrefs({ keyLock: c === true })
                      }
                      data-testid="matching-key-lock"
                      className="size-3.5"
                    />
                    Key lock: tempo changes don&apos;t shift the key
                  </label>
                )}
              </div>
            </FilterRow>

            <FilterRow label="Search in">
              <Select
                value={scope}
                onValueChange={(v) => updatePrefs({ scope: v })}
              >
                <SelectTrigger
                  size="sm"
                  data-testid="matching-scope"
                  className="h-7 w-full text-xs"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {current && (
                    <SelectItem value={CURRENT_SCOPE} className="text-xs">
                      Current playlist ({current.name})
                    </SelectItem>
                  )}
                  <SelectItem value={COLLECTION_SCOPE} className="text-xs">
                    Whole collection
                  </SelectItem>
                  {scopablePlaylists.length > 0 && <SelectSeparator />}
                  {scopablePlaylists.map((p) => (
                    <SelectItem key={p.id} value={p.id} className="text-xs">
                      <ListMusic className="size-3.5" />
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FilterRow>

            <FilterRow label="Genre">
              <Popover>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    data-testid="matching-genre"
                    className="border-input flex h-7 w-full cursor-pointer items-center justify-between gap-2 rounded-md border px-2.5 text-xs"
                  >
                    <span className="truncate">
                      {genres.length === 0 ? "Any genre" : genres.join(", ")}
                    </span>
                    <ChevronDown className="size-3.5 shrink-0 text-[var(--text-muted)]" />
                  </button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-64 p-1">
                  <MotionMultiselect
                    options={Object.keys(genreCounts).map((g) => ({
                      id: g,
                      label: g,
                    }))}
                    selected={genres}
                    counts={genreCounts}
                    onToggle={(g) =>
                      setGenres((prev) =>
                        prev.includes(g)
                          ? prev.filter((x) => x !== g)
                          : [...prev, g],
                      )
                    }
                    emptyLabel="No genres"
                  />
                </PopoverContent>
              </Popover>
            </FilterRow>

            <FilterRow label="BPM">
              <div className="flex items-center gap-2">
                <NumberInput
                  value={bpmMin}
                  onChange={setBpmMin}
                  min={0}
                  ariaLabel="Minimum BPM"
                  testId="matching-bpm-min"
                  className="h-7"
                />
                <span className="text-[var(--text-muted)]">–</span>
                <NumberInput
                  value={bpmMax}
                  onChange={setBpmMax}
                  min={0}
                  ariaLabel="Maximum BPM"
                  testId="matching-bpm-max"
                  className="h-7"
                />
              </div>
            </FilterRow>
          </div>
        )}

        {sourceTrack && (
          <div className="flex items-center justify-between px-4 py-2 text-xs text-[var(--text-muted)]">
            <span data-testid="matching-count" className="tabular-nums">
              {matches.length === 1 ? "1 match" : `${matches.length} matches`}
            </span>
            {refBpm && (
              <span className="tabular-nums">
                Keys as heard at {refBpm.toFixed(1)} BPM
              </span>
            )}
          </div>
        )}

        <div ref={setScrollEl} className="min-h-0 flex-1 overflow-y-auto">
          {sourceTrack && poolLoading && matches.length === 0 ? (
            <div className="flex h-32 items-center justify-center">
              <LogoSpinner className="size-6" />
            </div>
          ) : sourceTrack && matches.length === 0 ? (
            <p className="px-4 py-6 text-center text-xs text-[var(--text-muted)]">
              No tracks match these filters.
            </p>
          ) : (
            <div
              className="relative w-full"
              style={{ height: virtualizer.getTotalSize() }}
            >
              {virtualizer.getVirtualItems().map((v) => {
                const row = rows[v.index];
                return (
                  <div
                    key={v.key}
                    className="absolute inset-x-0"
                    style={{ top: v.start, height: v.size }}
                  >
                    {row.kind === "header" ? (
                      <div
                        data-testid="matching-group-header"
                        className={cn(
                          "text-2xs flex h-full items-end px-4 pb-1 tracking-wider text-[var(--text-muted)] uppercase",
                          !row.first && "border-border border-t",
                        )}
                      >
                        {row.label}
                      </div>
                    ) : (
                      <MatchRow
                        item={row.item}
                        pitch={pitchOf(row.item.track)}
                        device={device}
                        isCurrent={
                          !!row.item.track.file_path &&
                          player.activeTrack?.filePath ===
                            row.item.track.file_path
                        }
                        onPlay={() => play(row.item.track)}
                        onPlayNext={(pt) => player.playNext(pt)}
                        onAddToQueue={(pt) => player.enqueue(pt)}
                        addToPlaylist={
                          current?.onAdd && !row.item.inPlaylist
                            ? {
                                name: current.name,
                                run: () => current.onAdd?.([row.item.track]),
                              }
                            : null
                        }
                      />
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function FilterRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[4.5rem_1fr] items-start gap-2">
      <span className="pt-1.5 text-xs text-[var(--text-muted)]">{label}</span>
      {children}
    </div>
  );
}

function SourceSummary({
  track,
  refBpm,
  sourceShift,
}: {
  track: RekordboxTrack;
  refBpm: number | null;
  sourceShift: number;
}) {
  const heard =
    track.key && sourceShift !== 0
      ? transposeKey(track.key, sourceShift)
      : null;
  return (
    <span className="flex flex-col gap-0.5">
      <span className="truncate font-medium text-[var(--text)]">
        {track.title}
        {track.artist && (
          <span className="font-normal text-[var(--text-muted)]">
            {" "}
            · {track.artist}
          </span>
        )}
      </span>
      <span className="tabular-nums">
        {track.bpm?.toFixed(1) ?? "—"} BPM · {track.key ?? "no key"}
        {heard && refBpm && (
          <>
            {" "}
            → <span className="text-[var(--brand)]">{heard}</span> at{" "}
            {refBpm.toFixed(1)}
          </>
        )}
      </span>
    </span>
  );
}

function MatchRow({
  item,
  pitch,
  device,
  isCurrent,
  onPlay,
  onPlayNext,
  onAddToQueue,
  addToPlaylist,
}: {
  item: Match;
  /** Exact semitones the track shifts at the reference tempo. */
  pitch: number;
  device: string | null;
  isCurrent: boolean;
  onPlay: () => void;
  onPlayNext: (t: PlayerTrack) => void;
  onAddToQueue: (t: PlayerTrack) => void;
  addToPlaylist: { name: string; run: () => void } | null;
}) {
  const { track: t, match } = item;
  const pt = rekordboxPlayerTrack(t, device ?? "");
  const { setNodeRef, listeners, isDragging } = useExternalTrackDrag(t);
  const rule = match ? KEY_RULES.find((r) => r.id === match.rule) : null;
  const detuned = !!match && match.detune > DETUNE_LIMIT_SEMITONES;
  const heardKey = t.key ? transposeKey(t.key, Math.round(pitch)) : null;
  const pitched = !!t.key && pitch !== 0;

  return (
    <TrackQueueMenu
      disabled={!pt}
      onPlayNext={() => pt && onPlayNext(pt)}
      onAddToQueue={() => pt && onAddToQueue(pt)}
      extraItems={
        addToPlaylist ? (
          <ContextMenuItem
            data-testid="matching-add-to-playlist"
            className="text-xs"
            onSelect={addToPlaylist.run}
          >
            <ListMusic className="size-3.5" />
            Add to {addToPlaylist.name}
          </ContextMenuItem>
        ) : undefined
      }
    >
      <div
        ref={setNodeRef}
        {...listeners}
        data-testid="matching-track"
        data-track-id={t.id}
        data-rule={match?.rule ?? ""}
        onClick={() => pt && onPlay()}
        className={cn(
          "flex h-full items-center gap-2 px-4 text-xs select-none",
          isDragging && "opacity-40",
          pt
            ? "cursor-pointer hover:bg-[var(--surface-3)]"
            : "cursor-default text-[var(--text-subtle)]",
          isCurrent && "bg-[var(--brand-soft)]",
        )}
      >
        <CoverPlayButton
          artworkUrl={
            t.has_artwork
              ? api.getRekordboxArtworkUrl(t.id, true, device ?? undefined)
              : null
          }
          isCurrent={isCurrent}
          onStartPlay={pt ? onPlay : undefined}
          label={t.title}
          className="size-7"
        />
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">{t.title || "—"}</div>
          <div className="text-2xs truncate text-[var(--text-muted)]">
            {[t.artist, t.genre].filter(Boolean).join(" · ") || "—"}
          </div>
        </div>
        <span className="w-10 shrink-0 text-right text-[var(--text-muted)] tabular-nums">
          {t.bpm?.toFixed(1) ?? "—"}
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              data-testid="matching-heard-key"
              className={cn(
                "w-8 shrink-0 text-right tabular-nums",
                heardKey !== t.key
                  ? "font-medium text-[var(--brand)]"
                  : "text-[var(--text-muted)]",
              )}
            >
              {heardKey ?? "—"}
            </span>
          </TooltipTrigger>
          {pitched && (
            <TooltipContent side="top" className="tabular-nums">
              Original key {t.key} · {pitch > 0 ? "+" : ""}
              {pitch.toFixed(2)} st
            </TooltipContent>
          )}
        </Tooltip>
        <span className="flex w-16 shrink-0 items-center justify-end gap-1">
          {detuned && (
            <Tooltip>
              <TooltipTrigger asChild>
                <TriangleAlert
                  data-testid="matching-detuned"
                  className="size-3.5 text-[var(--warning)]"
                />
              </TooltipTrigger>
              <TooltipContent side="top" className="tabular-nums">
                Detuned: {match.detune.toFixed(2)} semitones off once pitched
              </TooltipContent>
            </Tooltip>
          )}
          {rule && (
            <span className="text-2xs rounded-sm border border-[var(--border)] px-1 py-px text-[var(--text-muted)]">
              {rule.label}
            </span>
          )}
        </span>
      </div>
    </TrackQueueMenu>
  );
}
