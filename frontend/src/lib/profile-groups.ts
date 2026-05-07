import type { components } from "@/generated/backend";
import { fetchApi } from "@/lib/api";
import type { SCTrack } from "@/lib/soundcloud";

export type ProfileGroupMember = components["schemas"]["ProfileGroupMember"];
export type ProfileGroup = components["schemas"]["ProfileGroup"];
export type ProfileGroupsResponse =
  components["schemas"]["ProfileGroupsResponse"];
export type ProfileGroupCreate = components["schemas"]["ProfileGroupCreate"];
export type ProfileGroupUpdate = components["schemas"]["ProfileGroupUpdate"];

/** Minimal view of a profile that can attribute a liked track. Both
 * `ProfileGroupMember` and SoundCloud's `SCUser` are structurally
 * compatible. */
export type SourceProfile = {
  user_urn: string;
  username: string;
  avatar_url: string | null;
};

/** A merged-feed track tagged with the members who liked it.
 *
 * Underscore prefix marks these fields as client-only — they're synthesized
 * by `mergeGroupedLikes` and are never serialized back to any API. */
export type GroupedTrack = SCTrack & {
  __sources: SourceProfile[];
  __likedAt: string;
};

export const TRANSIENT_GROUP_ID = "__transient__";

export const profileGroupsApi = {
  list(): Promise<ProfileGroupsResponse> {
    return fetchApi("/api/profile-groups");
  },
  getActive(): Promise<ProfileGroup | null> {
    return fetchApi("/api/profile-groups/active");
  },
  create(payload: ProfileGroupCreate): Promise<ProfileGroup> {
    return fetchApi("/api/profile-groups", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },
  update(id: string, payload: ProfileGroupUpdate): Promise<ProfileGroup> {
    return fetchApi(`/api/profile-groups/${id}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    });
  },
  delete(id: string): Promise<void> {
    return fetchApi(`/api/profile-groups/${id}`, { method: "DELETE" }).then(
      () => undefined,
    );
  },
  activate(id: string): Promise<ProfileGroup> {
    return fetchApi(`/api/profile-groups/${id}/activate`, { method: "PUT" });
  },
};

/** Merge per-member liked-tracks into one feed.
 *
 * Dedupe by `track.urn`; the first occurrence keeps the row identity but
 * `__sources` accumulates every member who liked the track.
 *
 * Order: insertion order across `perMember`. SoundCloud returns each
 * member's likes/reposts in activity-desc (most-recent-first) order; a
 * track's own `created_at` is its upload date, not the liked-at, so we
 * trust the API order rather than re-sorting. For multi-member groups
 * this means: member-A's most-recent likes first, then member-B's likes
 * not already in A, etc.
 */
export function mergeGroupedLikes(
  perMember: Array<{ source: SourceProfile; tracks: SCTrack[] }>,
): GroupedTrack[] {
  const byUrn = new Map<string, GroupedTrack>();

  for (const { source, tracks } of perMember) {
    for (const t of tracks) {
      const key = t.urn ?? "";
      if (!key) continue;
      const existing = byUrn.get(key);
      if (existing) {
        existing.__sources.push(source);
      } else {
        byUrn.set(key, {
          ...t,
          __sources: [source],
          __likedAt: t.created_at ?? "",
        });
      }
    }
  }

  return [...byUrn.values()];
}
