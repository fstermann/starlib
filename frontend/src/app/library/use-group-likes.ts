import { useEffect, useState } from "react";

import {
  mergeGroupedLikes,
  type GroupedTrack,
  type ProfileGroup,
} from "@/lib/profile-groups";
import {
  fetchLikesPage,
  getUserLikedTracks,
  type SCTrack,
} from "@/lib/soundcloud";

interface UseGroupLikesResult {
  tracks: GroupedTrack[];
  loading: boolean;
  error: string | null;
}

const PAGE_SIZE = 200;

async function fetchAllUserLikes(
  userUrn: string,
  isCancelled: () => boolean,
  onPage: (tracks: SCTrack[]) => void,
): Promise<void> {
  const first = await getUserLikedTracks(userUrn, PAGE_SIZE);
  if (isCancelled()) return;
  if (first.collection?.length) onPage(first.collection);
  let nextUrl = first.next_href;
  while (nextUrl && !isCancelled()) {
    const resp = await fetchLikesPage(nextUrl);
    if (isCancelled()) return;
    if (resp.collection?.length) onPage(resp.collection);
    nextUrl = resp.next_href;
  }
}

/** Fetches all likes for each member of a ProfileGroup (following SoundCloud
 * cursor pagination) and merges them via `mergeGroupedLikes`. */
export function useGroupLikes(group: ProfileGroup | null): UseGroupLikesResult {
  const [tracks, setTracks] = useState<GroupedTrack[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Stable string key that changes only when the relevant member set changes,
  // so the effect doesn't refire on group-name edits.
  const memberKey = group
    ? `${group.id ?? ""}|${(group.members ?? [])
        .map((m) => m.user_urn)
        .join(",")}`
    : "";

  useEffect(() => {
    const members = group?.members ?? [];
    if (!group || members.length === 0) {
      setTracks([]);
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    setTracks([]);
    setLoading(true);
    setError(null);

    const perMember = members.map((m) => ({
      source: {
        user_urn: m.user_urn,
        username: m.username,
        avatar_url: m.avatar_url ?? null,
      },
      tracks: [] as SCTrack[],
    }));

    Promise.all(
      members.map((m, idx) =>
        fetchAllUserLikes(
          m.user_urn,
          () => cancelled,
          (page) => {
            if (cancelled) return;
            perMember[idx].tracks = perMember[idx].tracks.concat(page);
            setTracks(mergeGroupedLikes(perMember));
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
        setError(err instanceof Error ? err.message : "Failed to load likes");
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memberKey]);

  return { tracks, loading, error };
}
