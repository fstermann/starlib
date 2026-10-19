import { describe, expect, it } from "vitest";

import { Follower, type Playhead } from "./media-follow";

function fakePlayer() {
  let onSeeked = () => {};
  const seeks: number[] = [];
  const player: Playhead & { seeks: number[]; land: () => void } = {
    seeks,
    get currentTime() {
      return seeks.at(-1) ?? 0;
    },
    set currentTime(t: number) {
      seeks.push(t);
    },
    addEventListener: (_type, listener) => {
      onSeeked = listener;
    },
    land: () => onSeeked(),
  };
  return player;
}

describe("Follower", () => {
  it("aims a jump ahead by how long the last one took to land", () => {
    let now = 0;
    const player = fakePlayer();
    const follower = new Follower(player, () => now);

    follower.jump(180, true);
    now = 600;
    player.land();
    follower.jump(300, true);

    expect(player.seeks).toEqual([180, 300.6]);
  });

  it("doesn't aim ahead while paused", () => {
    let now = 0;
    const player = fakePlayer();
    const follower = new Follower(player, () => now);

    follower.jump(180, true);
    now = 600;
    player.land();
    follower.jump(300, false);

    expect(player.seeks).toEqual([180, 300]);
  });
});
