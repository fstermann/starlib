"use client";

import { useEffect, useRef, useState } from "react";

import { jobAudioUrl } from "@/lib/breakdown";
import { levelMatchGainsDb } from "@/lib/level-match";
import { Follower } from "@/lib/media-follow";
import { glide, hasOutput, outputFor, releaseOutput } from "@/lib/media-output";

export interface AbSource {
  jobId: string;
  /** Integrated loudness; null when the set isn't measured, which leaves it unmatched. */
  lufs: number | null;
}

export interface AbListen {
  /** The job being heard: this set's or a reference's; null before the first switch. */
  heard: string | null;
  listen: (jobId: string) => void;
  levelMatch: boolean;
  setLevelMatch: (on: boolean) => void;
  /** Gain each set plays at while switching, in dB, by job. */
  gainsDb: Map<string, number>;
}

// Let a fade-out finish before pausing, so the switch doesn't click.
const FADE_MS = 40;

/** Stop a reference for good: drop its file (removing ``src`` alone keeps it loaded) and its audio nodes. */
function discard(player: HTMLAudioElement) {
  player.pause();
  player.removeAttribute("src");
  player.load();
  releaseOutput(player);
}

/**
 * A/B between this set and its references. The set player always runs, since
 * it drives the timeline; a reference plays only while it's the one heard,
 * synced once when switched to and on every skip. Nothing re-seeks during
 * playback: in WebKit each seek is audible.
 */
export function useAbListen(
  media: HTMLMediaElement | null,
  self: AbSource | null,
  references: AbSource[],
): AbListen {
  // The choice belongs to the set it was made on; opening another set starts fresh.
  const [choice, setChoice] = useState<{ self: string; heard: string }>();
  const [levelMatch, setLevelMatch] = useState(true);
  const players = useRef(
    new Map<string, { player: HTMLAudioElement; follower: Follower }>(),
  );
  // The reference currently running, read by the set player's event handlers.
  const running = useRef<string | null>(null);
  const selfId = self?.jobId ?? null;
  const engaged = choice != null && choice.self === selfId;
  // Unpicking the reference being heard falls back to this set.
  const heard = !engaged
    ? null
    : references.some((r) => r.jobId === choice.heard)
      ? choice.heard
      : selfId;

  const sources = self ? [self, ...references] : references;
  const matched = levelMatchGainsDb(sources.map((s) => s.lufs));
  const gainsDb = new Map(
    sources.map((s, i) => [s.jobId, levelMatch ? matched[i] : 0]),
  );
  const referenceKey = references.map((r) => r.jobId).join(",");

  // One paused player per reference; the running one follows the set player's transport.
  useEffect(() => {
    if (!engaged || !media) return;
    const wanted = new Set(referenceKey ? referenceKey.split(",") : []);
    for (const [jobId, { player }] of players.current) {
      if (wanted.has(jobId)) continue;
      discard(player);
      players.current.delete(jobId);
      if (running.current === jobId) running.current = null;
    }
    for (const jobId of wanted) {
      if (players.current.has(jobId)) continue;
      const player = new Audio();
      player.crossOrigin = "anonymous";
      player.preload = "metadata";
      player.src = jobAudioUrl(jobId);
      glide(outputFor(player).gain.gain, 0);
      players.current.set(jobId, { player, follower: new Follower(player) });
    }

    const current = () =>
      running.current ? players.current.get(running.current) : undefined;
    const onPlay = () =>
      void current()
        ?.player.play()
        .catch(() => {});
    const onPause = () => current()?.player.pause();
    const onSeek = () =>
      current()?.follower.jump(media.currentTime, !media.paused);
    media.addEventListener("play", onPlay);
    media.addEventListener("pause", onPause);
    media.addEventListener("seeking", onSeek);
    return () => {
      media.removeEventListener("play", onPlay);
      media.removeEventListener("pause", onPause);
      media.removeEventListener("seeking", onSeek);
    };
  }, [engaged, media, referenceKey]);

  // Stop every reference when the set player goes away (another set, or leaving the page).
  useEffect(() => {
    const current = players.current;
    return () => {
      current.forEach(({ player }) => discard(player));
      current.clear();
      running.current = null;
      if (media && hasOutput(media)) glide(outputFor(media).gain.gain, 1);
    };
  }, [media]);

  // Switch: start the heard reference at the set's position, fade, then pause the one left.
  const gainsKey = [...gainsDb].join(";");
  useEffect(() => {
    if (!engaged || !media || !self) return;
    const level = (jobId: string) => 10 ** ((gainsDb.get(jobId) ?? 0) / 20);
    glide(
      outputFor(media).gain.gain,
      heard === self.jobId ? level(self.jobId) : 0,
    );
    const next = heard === self.jobId ? null : heard;
    if (next !== running.current) {
      const leftId = running.current;
      const left = leftId ? players.current.get(leftId) : undefined;
      if (left) {
        glide(outputFor(left.player).gain.gain, 0);
        setTimeout(() => {
          // Switching straight back keeps it playing.
          if (running.current !== leftId) left.player.pause();
        }, FADE_MS);
      }
      const entry = next ? players.current.get(next) : undefined;
      if (entry) {
        entry.follower.jump(media.currentTime, !media.paused);
        if (!media.paused) void entry.player.play().catch(() => {});
      }
      running.current = next;
    }
    if (running.current) {
      const entry = players.current.get(running.current);
      if (entry)
        glide(outputFor(entry.player).gain.gain, level(running.current));
    }
    // gainsKey stands in for gainsDb, which is a new Map every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engaged, media, self?.jobId, heard, gainsKey, referenceKey]);

  const listen = (jobId: string) => {
    if (selfId) setChoice({ self: selfId, heard: jobId });
  };
  return { heard, listen, levelMatch, setLevelMatch, gainsDb };
}
