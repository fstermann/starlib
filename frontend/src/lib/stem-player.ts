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

/** Samples per min/max block of the waveform overview. */
export const WAVEFORM_BLOCK = 64;
const ANALYSER_FFT_SIZE = 8192;

/** Min/max and energy of one or more summed lanes per block of {@link WAVEFORM_BLOCK} samples. */
export interface Waveform {
  /** Interleaved `[min, max]` per block. */
  blocks: Float32Array;
  /** Sum of squared samples per block, for RMS over any range of blocks. */
  energy: Float32Array;
  blockS: number;
}

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
  /** Spectrum of everything audible, after mute/solo/volume. */
  readonly analyser: AnalyserNode;
  private readonly waveforms = new Map<string, Waveform>();
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
    private readonly onLoaded: (name: string) => void = () => {},
  ) {
    this.ctx = getSharedAudioContext();
    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = ANALYSER_FFT_SIZE;
    this.analyser.smoothingTimeConstant = 0.8;
    this.master.connect(this.analyser);
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
      this.onLoaded(name);
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

  /** Waveform of the named lanes summed, built once all of them are decoded. */
  waveform(names: string[]): Waveform | null {
    const key = names.join(",");
    const cached = this.waveforms.get(key);
    if (cached) return cached;
    const buffers = names.map((n) => this.lanes.get(n)?.buffer);
    if (buffers.some((b) => !b)) return null;
    const channels = (buffers as AudioBuffer[]).flatMap((b) =>
      Array.from({ length: Math.min(b.numberOfChannels, 2) }, (_, c) => ({
        data: b.getChannelData(c),
        weight: 1 / Math.min(b.numberOfChannels, 2),
      })),
    );
    const length = Math.max(...channels.map((c) => c.data.length));
    const nBlocks = Math.ceil(length / WAVEFORM_BLOCK);
    const blocks = new Float32Array(nBlocks * 2);
    const energy = new Float32Array(nBlocks);
    for (let b = 0; b < nBlocks; b++) {
      let min = 0;
      let max = 0;
      let sumSq = 0;
      const end = Math.min(length, (b + 1) * WAVEFORM_BLOCK);
      for (let i = b * WAVEFORM_BLOCK; i < end; i++) {
        let sample = 0;
        for (const c of channels) sample += (c.data[i] ?? 0) * c.weight;
        if (sample < min) min = sample;
        if (sample > max) max = sample;
        sumSq += sample * sample;
      }
      blocks[2 * b] = min;
      blocks[2 * b + 1] = max;
      energy[b] = sumSq;
    }
    const waveform = {
      blocks,
      energy,
      blockS: WAVEFORM_BLOCK / (buffers[0] as AudioBuffer).sampleRate,
    };
    this.waveforms.set(key, waveform);
    return waveform;
  }

  isLoaded(name: string): boolean {
    return this.lanes.get(name)?.buffer != null;
  }

  destroy(): void {
    this.destroyed = true;
    this.pause();
    for (const lane of this.lanes.values()) lane.gain.disconnect();
    this.master.disconnect();
    this.analyser.disconnect();
  }
}
