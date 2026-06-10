/**
 * Single-slot playback arbiter — only one audio surface plays at a time.
 *
 * Starlib has three independent audio sources that used to talk over
 * each other: the analyser's set audio (WaveSurfer), Shazam preview
 * clips (a shared `<audio>`), and the global SoundCloud player. Each
 * source claims the slot when it starts playing; claiming pauses
 * whichever source held it before. Sources release the slot when they
 * stop on their own so a stale pause callback never fires later.
 */

let holder: { id: string; pause: () => void } | null = null;

/** Take the playback slot, pausing the current holder (if different). */
export function claimPlayback(id: string, pause: () => void): void {
  if (holder && holder.id !== id) holder.pause();
  holder = { id, pause };
}

/** Give up the slot. No-op when another source has claimed it since. */
export function releasePlayback(id: string): void {
  if (holder?.id === id) holder = null;
}

/** Test hook — clears the slot without pausing anything. */
export function _resetPlaybackForTests(): void {
  holder = null;
}
