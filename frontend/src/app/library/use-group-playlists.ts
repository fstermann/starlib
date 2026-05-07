import { useEffect, useState } from "react";

import { type ProfileGroup, type SourceProfile } from "@/lib/profile-groups";
import { getUserPlaylists, type SCPlaylist } from "@/lib/soundcloud";

export interface MemberPlaylists {
  source: SourceProfile;
  playlists: SCPlaylist[];
}

interface UseGroupPlaylistsResult {
  byMember: MemberPlaylists[];
  /** Flat union of all members' playlists, member-order then API-order. */
  allPlaylists: SCPlaylist[];
  loading: boolean;
  error: string | null;
}

const PAGE_SIZE = 50;

async function fetchAllUserPlaylists(
  userUrn: string,
  isCancelled: () => boolean,
  onPage: (playlists: SCPlaylist[]) => void,
): Promise<void> {
  let nextHref: string | undefined = undefined;
  do {
    const page = await getUserPlaylists(userUrn, PAGE_SIZE, nextHref, false);
    if (isCancelled()) return;
    if (page.collection?.length) onPage(page.collection);
    nextHref = page.next_href ?? undefined;
  } while (nextHref && !isCancelled());
}

/** Per-member playlists for a ProfileGroup, paginated and streamed.
 *
 * Mirrors `useGroupLikes` / `useGroupReposts` but for playlist metadata.
 * Returns a `byMember` array (preserving group member order) and a flat
 * `allPlaylists` union for callers that need every playlist regardless
 * of source — used by the combined-tracks view and the playlist-by-urn
 * lookup. */
export function useGroupPlaylists(
  group: ProfileGroup | null,
): UseGroupPlaylistsResult {
  const [byMember, setByMember] = useState<MemberPlaylists[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const memberKey = group
    ? `${group.id ?? ""}|${(group.members ?? [])
        .map((m) => m.user_urn)
        .join(",")}`
    : "";

  useEffect(() => {
    const members = group?.members ?? [];
    if (!group || members.length === 0) {
      setByMember([]);
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    const buf: MemberPlaylists[] = members.map((m) => ({
      source: {
        user_urn: m.user_urn,
        username: m.username,
        avatar_url: m.avatar_url ?? null,
      },
      playlists: [],
    }));
    setByMember(buf.map((m) => ({ ...m, playlists: [] })));
    setLoading(true);
    setError(null);

    Promise.all(
      members.map((m, idx) =>
        fetchAllUserPlaylists(
          m.user_urn,
          () => cancelled,
          (page) => {
            if (cancelled) return;
            buf[idx].playlists = buf[idx].playlists.concat(page);
            setByMember(
              buf.map((m) => ({ ...m, playlists: [...m.playlists] })),
            );
          },
        ),
      ),
    )
      .then(() => {
        if (cancelled) return;
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(
          err instanceof Error ? err.message : "Failed to load playlists",
        );
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memberKey]);

  const allPlaylists = byMember.flatMap((m) => m.playlists);
  return { byMember, allPlaylists, loading, error };
}
