import { describe, expect, it } from "vitest";

import type { SCTrack } from "@/lib/soundcloud";

import { mergeGroupedLikes, type SourceProfile } from "./profile-groups";

function user(id: number, username: string): SourceProfile {
  return {
    user_urn: `soundcloud:users:${id}`,
    username,
    avatar_url: null,
  };
}

function track(id: number, likedAt: string): SCTrack {
  return {
    urn: `soundcloud:tracks:${id}`,
    title: `Track ${id}`,
    created_at: likedAt,
    duration: 200_000,
    user: { username: "owner" },
  } as SCTrack;
}

describe("mergeGroupedLikes", () => {
  it("returns empty for empty input", () => {
    expect(mergeGroupedLikes([])).toEqual([]);
  });

  it("returns a single member's tracks tagged with their user", () => {
    const alice = user(1, "alice");
    const result = mergeGroupedLikes([
      { source: alice, tracks: [track(10, "2024-01-02"), track(11, "2024-01-01")] },
    ]);
    expect(result).toHaveLength(2);
    expect(result[0].__sources).toEqual([alice]);
    expect(result[0].__likedAt).toBe("2024-01-02");
    expect(result[1].__likedAt).toBe("2024-01-01");
  });

  it("unions disjoint tracks from two members, sorted by likedAt desc", () => {
    const alice = user(1, "alice");
    const bob = user(2, "bob");
    const result = mergeGroupedLikes([
      { source: alice, tracks: [track(10, "2024-01-01")] },
      { source: bob, tracks: [track(20, "2024-02-01")] },
    ]);
    expect(result).toHaveLength(2);
    expect(result[0].urn).toBe("soundcloud:tracks:20");
    expect(result[0].__sources).toEqual([bob]);
    expect(result[1].urn).toBe("soundcloud:tracks:10");
    expect(result[1].__sources).toEqual([alice]);
  });

  it("dedupes a track liked by multiple members and accumulates sources", () => {
    const alice = user(1, "alice");
    const bob = user(2, "bob");
    const result = mergeGroupedLikes([
      { source: alice, tracks: [track(10, "2024-01-01")] },
      { source: bob, tracks: [track(10, "2024-03-01")] },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].__sources).toEqual([alice, bob]);
    expect(result[0].__likedAt).toBe("2024-03-01");
  });

  it("orders ties by first-seen member order (stable)", () => {
    const alice = user(1, "alice");
    const bob = user(2, "bob");
    const result = mergeGroupedLikes([
      { source: alice, tracks: [track(10, "2024-01-01")] },
      { source: bob, tracks: [track(20, "2024-01-01")] },
    ]);
    expect(result.map((t) => t.urn)).toEqual([
      "soundcloud:tracks:10",
      "soundcloud:tracks:20",
    ]);
  });
});
