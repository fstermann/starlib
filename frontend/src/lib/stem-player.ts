/**
 * Sample-synchronised multi-lane playback for Track Breakdown.
 *
 * Every lane is a decoded `AudioBuffer`; all lanes start on the same
 * `AudioContext` clock time with the same offset, so stems stay locked to each
 * other and to the original. Lanes marked lazy (the original) decode only when
 * they first become audible, since each decoded lane costs ~150 MB for a
 * six-minute track.
 */

import { getSharedAudioContext } from "./looping-web-audio-player";

/** Lead time so every source is scheduled before it has to sound. */
const START_LEAD_S = 0.05;
const GAIN_SMOOTHING_S = 0.01;

export interface LoopRegion {
  start: number;
  end: number;
}

interface Lane {
  url: string;
  gain: GainNode;
  buffer: AudioBuffer | null;
  loading: Promise<void> | null;
  source: AudioBufferSourceNode | null;
}

export class StemPlayer {
  private readonly ctx: AudioContext;
  private readonly master: GainNode;
  private readonly lanes = new Map<string, Lane>();
  private startCtxTime = 0;
  private startOffset = 0;
  private pausedAt = 0;
  private loop: LoopRegion | null = null;
  private destroyed = false;
  playing = false;
  duration = 0;

  constructor(
    urls: Record<string, string>,
    private readonly onEnded: () => void = () => {},
  ) {
    this.ctx = getSharedAudioContext();
    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);
    for (const [name, url] of Object.entries(urls)) {
      const gain = this.ctx.createGain();
      gain.connect(this.master);
      this.lanes.set(name, {
        url,
        gain,
        buffer: null,
        loading: null,
        source: null,
      });
    }
  }

  /** Decode the named lanes; the rest load when first made audible. */
  async load(names: string[]): Promise<void> {
    await Promise.all(names.map((name) => this.ensureLoaded(name)));
  }

  private ensureLoaded(name: string): Promise<void> {
    const lane = this.lanes.get(name);
    if (!lane) return Promise.resolve();
    lane.loading ??= (async () => {
      const response = await fetch(lane.url);
      if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
      const buffer = await this.ctx.decodeAudioData(
        await response.arrayBuffer(),
      );
      if (this.destroyed) return;
      lane.buffer = buffer;
      this.duration = Math.max(this.duration, buffer.duration);
      if (this.playing)
        this.startLane(lane, this.ctx.currentTime + START_LEAD_S);
    })();
    return lane.loading;
  }

  /** Playback position in seconds. */
  currentTime(): number {
    return this.playing ? this.positionAt(this.ctx.currentTime) : this.pausedAt;
  }

  private positionAt(ctxTime: number): number {
    const raw = this.startOffset + Math.max(0, ctxTime - this.startCtxTime);
    const loop = this.loop;
    if (!loop || raw < loop.end) return raw;
    const length = loop.end - loop.start;
    return loop.start + ((raw - loop.start) % length);
  }

  async play(): Promise<void> {
    if (this.playing) return;
    if (this.ctx.state === "suspended") await this.ctx.resume();
    const when = this.ctx.currentTime + START_LEAD_S;
    this.startOffset = this.pausedAt;
    this.startCtxTime = when;
    this.playing = true;
    for (const lane of this.lanes.values()) this.startLane(lane, when);
  }

  private startLane(lane: Lane, when: number): void {
    if (!lane.buffer) return;
    const source = this.ctx.createBufferSource();
    source.buffer = lane.buffer;
    if (this.loop) {
      source.loop = true;
      source.loopStart = this.loop.start;
      source.loopEnd = this.loop.end;
    }
    source.connect(lane.gain);
    source.onended = () => {
      if (lane.source !== source || !this.playing) return;
      this.playing = false;
      this.pausedAt = 0;
      this.stopSources();
      this.onEnded();
    };
    source.start(when, this.positionAt(when));
    lane.source = source;
  }

  private stopSources(): void {
    for (const lane of this.lanes.values()) {
      if (!lane.source) continue;
      lane.source.onended = null;
      lane.source.stop();
      lane.source.disconnect();
      lane.source = null;
    }
  }

  pause(): void {
    if (!this.playing) return;
    this.pausedAt = this.currentTime();
    this.playing = false;
    this.stopSources();
  }

  seek(seconds: number): void {
    const target = Math.min(Math.max(0, seconds), this.duration || seconds);
    const wasPlaying = this.playing;
    if (wasPlaying) this.pause();
    this.pausedAt = target;
    if (wasPlaying) void this.play();
  }

  /** Loop a region, or stop looping with `null`. Jumps into the region if outside it. */
  setLoop(region: LoopRegion | null): void {
    const position = this.currentTime();
    const wasPlaying = this.playing;
    if (wasPlaying) this.pause();
    this.loop = region;
    this.pausedAt =
      region && (position < region.start || position >= region.end)
        ? region.start
        : position;
    if (wasPlaying) void this.play();
  }

  /** Set each lane's gain; a lazy lane starts loading once its gain is above 0. */
  setGains(gains: Record<string, number>): void {
    const now = this.ctx.currentTime;
    for (const [name, value] of Object.entries(gains)) {
      const lane = this.lanes.get(name);
      if (!lane) continue;
      lane.gain.gain.setTargetAtTime(value, now, GAIN_SMOOTHING_S);
      if (value > 0) void this.ensureLoaded(name);
    }
  }

  isLoaded(name: string): boolean {
    return this.lanes.get(name)?.buffer != null;
  }

  destroy(): void {
    this.destroyed = true;
    this.pause();
    for (const lane of this.lanes.values()) lane.gain.disconnect();
    this.master.disconnect();
  }
}
