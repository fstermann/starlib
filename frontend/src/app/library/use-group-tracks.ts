import { useEffect, useState } from "react";

import {
  mergeGroupedLikes,
  type GroupedTrack,
  type ProfileGroup,
} from "@/lib/profile-groups";
import {
  fetchTracksPage,
  getUserTracks,
  parseSCTimestamp,
  type SCTrack,
} from "@/lib/soundcloud";

interface UseGroupTracksResult {
  tracks: GroupedTrack[];
  loading: boolean;
  error: string | null;
}

const PAGE_SIZE = 200;

async function fetchAllUserTracks(
  userUrn: string,
  isCancelled: () => boolean,
  onPage: (tracks: SCTrack[]) => void,
): Promise<void> {
  const first = await getUserTracks(userUrn, PAGE_SIZE);
  if (isCancelled()) return;
  if (first.collection?.length) onPage(first.collection);
  let nextUrl = first.next_href;
  while (nextUrl && !isCancelled()) {
    const resp = await fetchTracksPage(nextUrl);
    if (isCancelled()) return;
    if (resp.collection?.length) onPage(resp.collection);
    nextUrl = resp.next_href;
  }
}

function sortByCreatedAtDesc(tracks: GroupedTrack[]): GroupedTrack[] {
  return [...tracks].sort((a, b) => {
    const ta = parseSCTimestamp(a.created_at) ?? 0;
    const tb = parseSCTimestamp(b.created_at) ?? 0;
    return tb - ta;
  });
}

/** Tracks equivalent of `useGroupReposts` — paginates fully per member.
 *
 * Each member's tracks are sorted client-side by created_at desc before merge,
 * so the round-robin interleave surfaces the most recently uploaded track from
 * every profile in the group at the top of the merged list. */
export function useGroupTracks(
  group: ProfileGroup | null,
): UseGroupTracksResult {
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

    const recompute = () => {
      const sorted = perMember.map((p) => ({
        source: p.source,
        tracks: [...p.tracks].sort((a, b) => {
          const ta = parseSCTimestamp(a.created_at) ?? 0;
          const tb = parseSCTimestamp(b.created_at) ?? 0;
          return tb - ta;
        }),
      }));
      setTracks(sortByCreatedAtDesc(mergeGroupedLikes(sorted)));
    };

    Promise.all(
      members.map((m, idx) =>
        fetchAllUserTracks(
          m.user_urn,
          () => cancelled,
          (page) => {
            if (cancelled) return;
            perMember[idx].tracks = perMember[idx].tracks.concat(page);
            recompute();
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
        setError(err instanceof Error ? err.message : "Failed to load tracks");
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memberKey]);

  return { tracks, loading, error };
}
