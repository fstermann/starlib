import { describe, expect, it } from "vitest";

import type { SCTrack } from "@/lib/soundcloud";

import {
  makeWeeklyFilterPredicate,
  type WeeklyFilterOptions,
} from "./use-weekly-filter";

const baseOptions: WeeklyFilterOptions = {
  search: "",
  genres: [],
  minDuration: null,
  maxDuration: null,
  trackType: null,
  releaseType: null,
  excludeSeen: false,
  inCollection: null,
  excludeOwnLikes: false,
};

function makeTrack(overrides: Partial<SCTrack>): SCTrack {
  return {
    urn: "soundcloud:tracks:1",
    title: "Track",
    duration: 200_000,
    ...overrides,
  } as SCTrack;
}

describe("weekly filter — release_type", () => {
  const release = makeTrack({
    urn: "soundcloud:tracks:1",
    title: "Original",
    isRepost: false,
  });
  const repost = makeTrack({
    urn: "soundcloud:tracks:2",
    title: "Reposted",
    isRepost: true,
  });

  it("passes both when filter is null", () => {
    const predicate = makeWeeklyFilterPredicate(baseOptions);
    expect(predicate(release)).toBe(true);
    expect(predicate(repost)).toBe(true);
  });

  it("passes only releases when filter is 'release'", () => {
    const predicate = makeWeeklyFilterPredicate({
      ...baseOptions,
      releaseType: "release",
    });
    expect(predicate(release)).toBe(true);
    expect(predicate(repost)).toBe(false);
  });

  it("passes only reposts when filter is 'repost'", () => {
    const predicate = makeWeeklyFilterPredicate({
      ...baseOptions,
      releaseType: "repost",
    });
    expect(predicate(release)).toBe(false);
    expect(predicate(repost)).toBe(true);
  });

  it("treats undefined isRepost as a release", () => {
    const untagged = makeTrack({ urn: "soundcloud:tracks:3" });
    const releaseOnly = makeWeeklyFilterPredicate({
      ...baseOptions,
      releaseType: "release",
    });
    const repostOnly = makeWeeklyFilterPredicate({
      ...baseOptions,
      releaseType: "repost",
    });
    expect(releaseOnly(untagged)).toBe(true);
    expect(repostOnly(untagged)).toBe(false);
  });
});
