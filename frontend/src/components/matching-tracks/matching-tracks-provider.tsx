"use client";

import { Blend } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
} from "react";

import type { RekordboxTrack } from "@/app/library/use-rekordbox";
import { useCommand } from "@/components/command-palette/use-command";
import { usePlayer, type PlayerTrack } from "@/lib/player-context";
import { cn } from "@/lib/utils";

import { MatchingTracksSheet } from "./matching-tracks-sheet";

/** The track to find matches for: a Rekordbox row, or a file looked up in the
 *  collection (the player's track). */
export type MatchingSource =
  | { track: RekordboxTrack; device: string | null }
  | { filePath: string; device: string | null };

/** The playlist open in the Rekordbox view, registered while it's mounted. */
export interface MatchingPlaylistContext {
  id: string;
  name: string;
  device: string | null;
  tracks: RekordboxTrack[];
  /** Present when the playlist is editable. */
  onAdd?: (tracks: RekordboxTrack[]) => void;
}

interface MatchingTracksContextValue {
  openFor: (source: MatchingSource) => void;
  setPlaylist: (playlist: MatchingPlaylistContext | null) => void;
  setHosted: (hosted: boolean) => void;
  sheet: React.ComponentProps<typeof MatchingTracksSheet>;
}

const MatchingTracksContext = createContext<MatchingTracksContextValue | null>(
  null,
);

export function useMatchingTracks(): MatchingTracksContextValue {
  const ctx = useContext(MatchingTracksContext);
  if (!ctx)
    throw new Error("useMatchingTracks must be used in MatchingTracksProvider");
  return ctx;
}

/** Register the open Rekordbox playlist for the "current playlist" scope. */
export function useMatchingTracksPlaylist(
  playlist: MatchingPlaylistContext | null,
) {
  const { setPlaylist } = useMatchingTracks();
  useEffect(() => {
    setPlaylist(playlist);
    return () => setPlaylist(null);
  }, [playlist, setPlaylist]);
}

/**
 * Renders the sheet in place of the provider, e.g. inside the Rekordbox view's
 * drag-and-drop scope so results can be dragged onto its playlists.
 */
export function MatchingTracksSheetOutlet() {
  const { setHosted, sheet } = useMatchingTracks();
  useLayoutEffect(() => {
    setHosted(true);
    return () => setHosted(false);
  }, [setHosted]);
  return <MatchingTracksSheet {...sheet} />;
}

/** A player track backed by a local file, which the collection may hold. */
function localSource(track: PlayerTrack | null): MatchingSource | null {
  if (!track || track.filePath.startsWith("soundcloud:")) return null;
  return { filePath: track.filePath, device: track.rekordboxDevice ?? null };
}

export function MatchingTracksProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState<MatchingSource | null>(null);
  const [playlist, setPlaylist] = useState<MatchingPlaylistContext | null>(
    null,
  );
  const [hosted, setHosted] = useState(false);
  const { currentTrack } = usePlayer();

  const openFor = useCallback((next: MatchingSource) => {
    setSource(next);
    setOpen(true);
  }, []);

  const playing = localSource(currentTrack);
  useCommand({
    id: "rekordbox.matching-tracks",
    label: `Show matching tracks for ${currentTrack?.title ?? currentTrack?.fileName ?? "the playing track"}`,
    description:
      "Find Rekordbox tracks that mix harmonically with the playing track.",
    icon: Blend,
    keywords: ["related", "harmonic", "key", "camelot", "mix", "rekordbox"],
    group: "Actions",
    when: !!playing,
    run: ({ close }) => {
      close();
      if (playing) openFor(playing);
    },
  });

  const value = useMemo(
    () => ({
      openFor,
      setPlaylist,
      setHosted,
      sheet: { open, onOpenChange: setOpen, source, playlist },
    }),
    [openFor, open, source, playlist],
  );

  return (
    <MatchingTracksContext.Provider value={value}>
      {children}
      {!hosted && <MatchingTracksSheet {...value.sheet} />}
    </MatchingTracksContext.Provider>
  );
}

/** Player-bar button: matching tracks for the playing track. */
export function MatchingTracksButton() {
  const { openFor } = useMatchingTracks();
  const { currentTrack } = usePlayer();
  const playing = localSource(currentTrack);
  return (
    <button
      type="button"
      data-testid="matching-tracks-trigger"
      disabled={!playing}
      onClick={() => playing && openFor(playing)}
      className={cn(
        "text-muted-foreground hover:text-foreground hover:bg-surface-3 flex size-6 cursor-pointer items-center justify-center rounded-full transition-colors",
        !playing && "cursor-not-allowed opacity-40 hover:bg-transparent",
      )}
      title="Matching tracks"
      aria-label="Show matching tracks"
    >
      <Blend className="size-3.5" />
    </button>
  );
}
