import { useEffect, useState } from "react";

import {
  mergeGroupedLikes,
  type GroupedTrack,
  type ProfileGroup,
} from "@/lib/profile-groups";
import { getUserRepostedTracks } from "@/lib/soundcloud";

interface UseGroupRepostsResult {
  tracks: GroupedTrack[];
  loading: boolean;
  error: string | null;
}

const PAGE_SIZE = 200;

/** Reposts equivalent of `useGroupLikes` — first page per member, merged. */
export function useGroupReposts(
  group: ProfileGroup | null,
): UseGroupRepostsResult {
  const [tracks, setTracks] = useState<GroupedTrack[]>([]);
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
        const resp = await getUserRepostedTracks(m.user_urn, PAGE_SIZE);
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
        setError(err instanceof Error ? err.message : "Failed to load reposts");
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memberKey]);

  return { tracks, loading, error };
}
