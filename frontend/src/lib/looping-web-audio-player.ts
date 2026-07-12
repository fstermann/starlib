import WebAudioPlayer from "wavesurfer.js/dist/webaudio.js";

export interface LoopRegion {
  /** Loop start, in seconds. */
  start: number;
  /** Loop end, in seconds. */
  end: number;
}

/**
 * One AudioContext for the whole app, reused across every track.
 *
 * Browsers cap the number of concurrent `AudioContext`s (~6 in Chrome). The
 * base player creates one per instance and closes it on `destroy()`, but
 * `close()` is async and the hardware slots free lazily — so skipping through a
 * handful of tracks can momentarily exceed the cap. Contexts created past it
 * come up without an output device: the clock still advances (so the waveform
 * keeps scrolling) while nothing is audible, and it stays broken. Sharing a
 * single long-lived context sidesteps that entirely and means we only ever
 * resume-after-gesture once.
 */
let sharedContext: AudioContext | null = null;
function getSharedAudioContext(): AudioContext {
  if (!sharedContext || sharedContext.state === "closed") {
    sharedContext = new AudioContext();
  }
  return sharedContext;
}

/**
 * The private fields we reach into on the base {@link WebAudioPlayer}. They are
 * TypeScript-`private` (compile-time only), so we cast through this shape rather
 * than fork the vendored class. Pinned to `wavesurfer.js@^7.12` — revisit on a
 * major bump.
 */
interface WebAudioInternals {
  bufferNode: AudioBufferSourceNode | null;
  buffer: AudioBuffer | null;
  currentSrc: string;
  playbackPosition: number;
  _destroyed: boolean;
  unAll(): void;
}

/**
 * A WaveSurfer `WebAudioPlayer` (Web Audio buffer source emulating an
 * `<audio>` element) extended with **gapless, sample-accurate looping** and
 * instant cue.
 *
 * The base player restarts its `AudioBufferSourceNode` on every seek — which on
 * Web Audio is instant (no HTMLMediaElement seek stall), so cue points and loop
 * restarts have no audible delay. For looping we go one better and use the
 * native `AudioBufferSourceNode.loop`/`loopStart`/`loopEnd`, so the wrap happens
 * on the audio thread with sample accuracy instead of a JS-polled seek.
 *
 * The base player tracks position linearly (`playbackPosition + elapsed`), which
 * a native loop would let grow unbounded past the loop end. We reconcile that:
 * - `currentTime` reports the position wrapped into the loop region;
 * - `pause()` stores the wrapped position so resume starts in the right place;
 * - clearing the loop resyncs by seeking to the wrapped position.
 */
export class LoopingWebAudioPlayer extends WebAudioPlayer {
  private loopRegion: LoopRegion | null = null;

  constructor() {
    // Reuse the app-wide context instead of minting one per track.
    super(getSharedAudioContext());
  }

  private get internals(): WebAudioInternals {
    return this as unknown as WebAudioInternals;
  }

  private get context(): BaseAudioContext {
    return this.getGainNode().context;
  }

  /**
   * Fetch and decode `url` into the playback buffer. Unlike the base `src`
   * setter (which swallows decode errors silently), this rejects on failure so
   * the caller can surface an error instead of hanging on a `canplay` that
   * never comes.
   */
  async loadBuffer(url: string): Promise<void> {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch audio: ${response.status}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    const buffer = await this.context.decodeAudioData(arrayBuffer);
    this.internals.buffer = buffer;
    this.internals.currentSrc = url;
    this.emit("loadedmetadata");
    this.emit("canplay");
  }

  /** Set (or clear) the active loop region. */
  setLoop(region: LoopRegion | null): void {
    const wasLooping = this.loopRegion != null && !this.paused;
    // Clearing an active loop: the base player's linear position may have run
    // past the loop end, so seek to the wrapped position to resync before
    // linear playback continues.
    if (wasLooping && region == null) {
      const wrapped = this.currentTime;
      this.loopRegion = null;
      this.currentTime = wrapped;
      return;
    }
    this.loopRegion = region;
    this.applyLoop();
  }

  /** Push the current loop region onto the live buffer node (if any). */
  private applyLoop(): void {
    const node = this.internals.bufferNode;
    if (!node) return;
    const region = this.loopRegion;
    if (region && region.end > region.start) {
      node.loop = true;
      node.loopStart = region.start;
      node.loopEnd = region.end;
    } else {
      node.loop = false;
    }
  }

  get currentTime(): number {
    const raw = super.currentTime;
    const region = this.loopRegion;
    if (region && region.end > region.start && raw > region.end) {
      const span = region.end - region.start;
      return region.start + ((raw - region.start) % span);
    }
    return raw;
  }

  set currentTime(value: number) {
    super.currentTime = value;
    this.applyLoop();
  }

  get playbackRate(): number {
    return super.playbackRate;
  }

  set playbackRate(value: number) {
    super.playbackRate = value;
    this.applyLoop();
  }

  async play(): Promise<void> {
    // A context created before a user gesture starts suspended; resume it now
    // (playback is always triggered by a click, so activation is present).
    // Guard against a context torn down mid-track-switch.
    if (this.context.state === "suspended") {
      await (this.context as AudioContext).resume().catch(() => {});
    }
    await super.play();
    this.applyLoop();
  }

  pause(): void {
    if (this.paused) return;
    // Snapshot the wrapped position before the base player folds the (possibly
    // past-loop-end) linear elapsed time into `playbackPosition`, so resume
    // starts inside the loop instead of clamping to 0.
    const wrapped = this.loopRegion ? this.currentTime : null;
    super.pause();
    if (wrapped != null) {
      this.internals.playbackPosition = wrapped;
    }
  }

  /**
   * Tear down this player's nodes but leave the shared AudioContext open — the
   * base `destroy()` would close it, breaking every later track. Mirrors the
   * base cleanup minus the `context.close()` call.
   */
  destroy(): void {
    const it = this.internals;
    if (it._destroyed) return;
    it._destroyed = true;
    it.currentSrc = "";
    if (it.bufferNode) {
      it.bufferNode.onended = null;
      try {
        it.bufferNode.stop();
      } catch {
        /* already stopped */
      }
      it.bufferNode.disconnect();
      it.bufferNode = null;
    }
    this.getGainNode().disconnect();
    it.buffer = null;
    it.unAll();
  }
}
