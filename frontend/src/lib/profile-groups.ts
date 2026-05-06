import { fetchApi } from "@/lib/api";
import type { SCTrack } from "@/lib/soundcloud";

import type { components } from "@/generated/backend";

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
 * `__sources` accumulates every member who liked it. `__likedAt` resolves
 * to the latest (max) liked-at across sources, so a re-like by another
 * member resurfaces the track. Final order: `__likedAt` desc, with member
 * order breaking ties (stable sort).
 */
export function mergeGroupedLikes(
  perMember: Array<{ source: SourceProfile; tracks: SCTrack[] }>,
): GroupedTrack[] {
  const byUrn = new Map<string, GroupedTrack>();
  let order = 0;
  const insertOrder = new Map<string, number>();

  for (const { source, tracks } of perMember) {
    for (const t of tracks) {
      const key = t.urn ?? "";
      if (!key) continue;
      const likedAt = t.created_at ?? "";
      const existing = byUrn.get(key);
      if (existing) {
        existing.__sources.push(source);
        if (likedAt > (existing.__likedAt ?? "")) {
          existing.__likedAt = likedAt;
        }
      } else {
        byUrn.set(key, {
          ...t,
          __sources: [source],
          __likedAt: likedAt,
        });
        insertOrder.set(key, order++);
      }
    }
  }

  return [...byUrn.values()].sort((a, b) => {
    if (a.__likedAt === b.__likedAt) {
      return (insertOrder.get(a.urn ?? "") ?? 0) -
        (insertOrder.get(b.urn ?? "") ?? 0);
    }
    return a.__likedAt < b.__likedAt ? 1 : -1;
  });
}
