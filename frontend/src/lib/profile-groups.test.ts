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

function track(id: number, uploadedAt: string): SCTrack {
  return {
    urn: `soundcloud:tracks:${id}`,
    title: `Track ${id}`,
    created_at: uploadedAt,
    duration: 200_000,
    user: { username: "owner" },
  } as SCTrack;
}

describe("mergeGroupedLikes", () => {
  it("returns empty for empty input", () => {
    expect(mergeGroupedLikes([])).toEqual([]);
  });

  it("preserves a single member's API order (liked-at desc from SoundCloud)", () => {
    const alice = user(1, "alice");
    // SoundCloud already returns these in liked-at desc; we must not
    // reorder by track.created_at (which is upload date, not liked-at).
    const result = mergeGroupedLikes([
      {
        source: alice,
        tracks: [track(10, "2020-01-02"), track(11, "2024-01-01")],
      },
    ]);
    expect(result.map((t) => t.urn)).toEqual([
      "soundcloud:tracks:10",
      "soundcloud:tracks:11",
    ]);
    expect(result[0].__sources).toEqual([alice]);
  });

  it("unions disjoint tracks from two members in member order", () => {
    const alice = user(1, "alice");
    const bob = user(2, "bob");
    const result = mergeGroupedLikes([
      { source: alice, tracks: [track(10, "2024-01-01")] },
      { source: bob, tracks: [track(20, "2024-02-01")] },
    ]);
    expect(result.map((t) => t.urn)).toEqual([
      "soundcloud:tracks:10",
      "soundcloud:tracks:20",
    ]);
    expect(result[0].__sources).toEqual([alice]);
    expect(result[1].__sources).toEqual([bob]);
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
  });

  it("interleaves members round-robin so each member's most-recent like surfaces near the top", () => {
    const alice = user(1, "alice");
    const bob = user(2, "bob");
    // Each list is liked-at desc per member. Without interleave, all of
    // alice's likes would precede any of bob's; with interleave, bob's
    // most-recent like (20) should sit between alice's first two.
    const result = mergeGroupedLikes([
      {
        source: alice,
        tracks: [
          track(10, "2024-01-01"),
          track(11, "2023-01-01"),
          track(12, "2022-01-01"),
        ],
      },
      {
        source: bob,
        tracks: [track(20, "2024-02-01"), track(21, "2023-02-01")],
      },
    ]);
    expect(result.map((t) => t.urn)).toEqual([
      "soundcloud:tracks:10",
      "soundcloud:tracks:20",
      "soundcloud:tracks:11",
      "soundcloud:tracks:21",
      "soundcloud:tracks:12",
    ]);
  });

  it("does not duplicate sources when the same member supplies the same urn twice", () => {
    const alice = user(1, "alice");
    const result = mergeGroupedLikes([
      {
        source: alice,
        tracks: [track(10, "2024-01-01"), track(10, "2024-01-01")],
      },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].__sources).toEqual([alice]);
  });
});
