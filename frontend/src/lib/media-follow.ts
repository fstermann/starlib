/**
 * Move one media element to another's position, as when switching A/B.
 *
 * Seeking a large file takes a while, during which the leader keeps playing,
 * so each jump aims ahead by how long the previous one took to land.
 */

export interface Playhead {
  currentTime: number;
  addEventListener(type: "seeked", listener: () => void): void;
}

// Aim no further ahead than this, however slow the last seek was.
const MAX_LEAD_S = 2;

export class Follower {
  private seekStartedAt: number | null = null;
  private leadS = 0;

  constructor(
    private readonly player: Playhead,
    private readonly now: () => number = () => performance.now(),
  ) {
    player.addEventListener("seeked", () => this.landed());
  }

  /** Move to the leader's position now, as when the leader itself seeks. */
  jump(leaderTime: number, playing: boolean): void {
    this.seekStartedAt = this.now();
    this.player.currentTime = leaderTime + (playing ? this.leadS : 0);
  }

  private landed(): void {
    const now = this.now();
    if (this.seekStartedAt != null) {
      this.leadS = Math.min(MAX_LEAD_S, (now - this.seekStartedAt) / 1000);
      this.seekStartedAt = null;
    }
  }
}
