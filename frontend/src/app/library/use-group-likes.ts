import { useEffect, useState } from "react";

import {
  mergeGroupedLikes,
  type GroupedTrack,
  type ProfileGroup,
} from "@/lib/profile-groups";
import { getUserLikedTracks } from "@/lib/soundcloud";

interface UseGroupLikesResult {
  tracks: GroupedTrack[];
  loading: boolean;
  error: string | null;
}

const PAGE_SIZE = 200;

/** Fetches first-page likes for each member of a ProfileGroup and merges
 * them into one feed via `mergeGroupedLikes`. v1 deliberately stops at the
 * first page per member — multi-member infinite scroll is non-trivial and
 * deferred. The cap of 200 likes/member matches `useLikes`. */
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
    setLoading(true);
    setError(null);
    Promise.all(
      members.map(async (m) => {
        const resp = await getUserLikedTracks(m.user_urn, PAGE_SIZE);
        return {
          source: {
            user_urn: m.user_urn,
            username: m.username,
            avatar_url: m.avatar_url ?? null,
          },
          tracks: resp.collection ?? [],
        };
      }),
    )
      .then((perMember) => {
        if (cancelled) return;
        setTracks(mergeGroupedLikes(perMember));
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
