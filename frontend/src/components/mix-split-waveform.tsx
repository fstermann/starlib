"use client";

interface MixSplitWaveformProps {
  /** Out-going (old) track — shown as the bottom half of the waveform. */
  oldContent: React.ReactNode;
  /** Incoming (new) track — shown as the top half of the waveform. */
  newContent: React.ReactNode;
  testId?: string;
}

/**
 * Split waveform for a crossfade: the incoming track fills the top half and the
 * out-going track the bottom half, overlaid in the same box (each full-size
 * waveform clipped to its half). Reads as one waveform whose top belongs to the
 * new track and bottom to the old. Once the transition ends the caller drops
 * this and renders the incoming track's full waveform.
 */
export function MixSplitWaveform({
  oldContent,
  newContent,
  testId,
}: MixSplitWaveformProps) {
  return (
    <div data-testid={testId} className="relative h-full">
      {/* Out-going — bottom half (top clipped away). */}
      <div
        className="absolute inset-0"
        style={{ clipPath: "inset(50% 0 0 0)" }}
      >
        {oldContent}
      </div>
      {/* Incoming — top half (bottom clipped away). */}
      <div
        className="absolute inset-0"
        style={{ clipPath: "inset(0 0 50% 0)" }}
      >
        {newContent}
      </div>
    </div>
  );
}
