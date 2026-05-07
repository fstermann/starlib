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
 * Order: position-based k-way interleave across members. SoundCloud v1
 * returns each member's likes/reposts in liked-at-desc order but does not
 * expose a per-like timestamp, so we can't sort the merged feed by true
 * activity time (tracked in #451). Instead we round-robin by index:
 * A[0], B[0], C[0], A[1], B[1], … This surfaces the most-recent like from
 * every member at the top, rather than dumping all of A before any of B.
 * Already-seen tracks are skipped at later positions but their source is
 * appended to the existing entry's `__sources`.
 */
export function mergeGroupedLikes(
  perMember: Array<{ source: SourceProfile; tracks: SCTrack[] }>,
): GroupedTrack[] {
  const byUrn = new Map<string, GroupedTrack>();
  const order: GroupedTrack[] = [];
  const maxLen = perMember.reduce((m, p) => Math.max(m, p.tracks.length), 0);

  for (let i = 0; i < maxLen; i++) {
    for (const { source, tracks } of perMember) {
      const t = tracks[i];
      if (!t) continue;
      const key = t.urn ?? "";
      if (!key) continue;
      const existing = byUrn.get(key);
      if (existing) {
        if (!existing.__sources.some((s) => s.user_urn === source.user_urn)) {
          existing.__sources.push(source);
        }
      } else {
        const entry: GroupedTrack = {
          ...t,
          __sources: [source],
          __likedAt: t.created_at ?? "",
        };
        byUrn.set(key, entry);
        order.push(entry);
      }
    }
  }

  return order;
}
