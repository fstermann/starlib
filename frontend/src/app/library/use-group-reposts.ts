import { useEffect, useState } from "react";

import {
  mergeGroupedLikes,
  type GroupedTrack,
  type ProfileGroup,
} from "@/lib/profile-groups";
import {
  fetchRepostsPage,
  getUserRepostedTracks,
  type SCTrack,
} from "@/lib/soundcloud";

interface UseGroupRepostsResult {
  tracks: GroupedTrack[];
  loading: boolean;
  error: string | null;
}

const PAGE_SIZE = 200;

async function fetchAllUserReposts(
  userUrn: string,
  isCancelled: () => boolean,
): Promise<SCTrack[]> {
  const all: SCTrack[] = [];
  const first = await getUserRepostedTracks(userUrn, PAGE_SIZE);
  if (isCancelled()) return all;
  if (first.collection) all.push(...first.collection);
  let nextUrl = first.next_href;
  while (nextUrl && !isCancelled()) {
    const resp = await fetchRepostsPage(nextUrl);
    if (isCancelled()) return all;
    if (resp.collection) all.push(...resp.collection);
    nextUrl = resp.next_href;
  }
  return all;
}

/** Reposts equivalent of `useGroupLikes` — paginates fully per member. */
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
        const tracks = await fetchAllUserReposts(m.user_urn, () => cancelled);
        return {
          source: {
            user_urn: m.user_urn,
            username: m.username,
            avatar_url: m.avatar_url ?? null,
          },
          tracks,
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
