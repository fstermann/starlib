"use client";

import { SlidersHorizontal } from "lucide-react";
import { useEffect, useState } from "react";

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { Deck } from "@/lib/mix/engine";
import { cn } from "@/lib/utils";

export interface TransitionDecks {
  a: Deck | null;
  b: Deck | null;
}

interface ChannelReading {
  volume: number;
  /** EQ gains in dB, or null for decks that can't be EQ'd (SoundCloud). */
  high: number | null;
  mid: number | null;
  low: number | null;
}

type Band = "high" | "mid" | "low";

const BANDS: { band: Band; label: string }[] = [
  { band: "high", label: "Hi" },
  { band: "mid", label: "Mid" },
  { band: "low", label: "Low" },
];

/** At or below this the band reads as killed. */
const KILL_DB = -30;
/** DJ-mixer EQ pot (DJM-900NXS2 range): 7 o'clock = -26 dB, 12 = 0, 5 = +6. */
const KNOB_HALF_TRAVEL_DEG = 150;
const KNOB_MIN_DB = -26;
const KNOB_MAX_DB = 6;

/** Knob angle from 12 o'clock (degrees, negative = left), linear in dB. */
export function eqKnobAngle(db: number): number {
  return db >= 0
    ? KNOB_HALF_TRAVEL_DEG * Math.min(1, db / KNOB_MAX_DB)
    : -KNOB_HALF_TRAVEL_DEG * Math.min(1, db / KNOB_MIN_DB);
}

function readChannel(deck: Deck): ChannelReading {
  return {
    volume: deck.gainParam.value,
    high: deck.highParam()?.value ?? null,
    mid: deck.midParam()?.value ?? null,
    low: deck.bassParam()?.value ?? null,
  };
}

/**
 * Live mixer readout for the running transition: volume and 3-band EQ of the
 * outgoing (A) and incoming (B) deck, polled from the decks' audio params.
 */
export function TransitionMixer({
  getDecks,
  transitioning,
}: {
  getDecks: () => TransitionDecks;
  transitioning: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [readings, setReadings] = useState<{
    a: ChannelReading | null;
    b: ChannelReading | null;
  } | null>(null);

  useEffect(() => {
    if (!open || !transitioning) return;
    let raf = 0;
    const tick = () => {
      const { a, b } = getDecks();
      setReadings({
        a: a ? readChannel(a) : null,
        b: b ? readChannel(b) : null,
      });
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [open, transitioning, getDecks]);

  const shown = transitioning ? readings : null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="player-mixer-btn"
          data-active={open || undefined}
          className={cn(
            "flex size-6 cursor-pointer items-center justify-center rounded-md border transition-colors",
            open
              ? "border-[var(--border-brand)] bg-[var(--brand-soft)] text-[var(--brand)]"
              : "border-[var(--border)] text-[var(--text-muted)] hover:bg-[var(--surface-3)] hover:text-[var(--text)]",
          )}
          title="Transition mixer"
          aria-label="Transition mixer"
        >
          <SlidersHorizontal className="size-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-56 p-3"
        data-testid="player-mixer-panel"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        {shown ? (
          <div className="grid grid-cols-[2.5rem_1fr_1fr] items-center gap-x-2 gap-y-1.5">
            <span />
            <DeckHeader label="A" sub="Out" />
            <DeckHeader label="B" sub="In" />
            {BANDS.map(({ band, label }) => (
              <BandRow
                key={band}
                band={band}
                label={label}
                a={shown.a}
                b={shown.b}
              />
            ))}
            <RowLabel>Vol</RowLabel>
            <VolumeCell deck="a" reading={shown.a} />
            <VolumeCell deck="b" reading={shown.b} />
          </div>
        ) : (
          <p className="text-xs leading-snug text-[var(--text-muted)]">
            Levels appear here when the transition starts.
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}

function DeckHeader({ label, sub }: { label: string; sub: string }) {
  return (
    <span className="text-2xs text-center tracking-wide text-[var(--text-muted)] uppercase">
      <span className="font-semibold text-[var(--text)]">{label}</span> {sub}
    </span>
  );
}

function RowLabel({ children }: { children: string }) {
  return (
    <span className="text-2xs tracking-wide text-[var(--text-muted)] uppercase">
      {children}
    </span>
  );
}

function BandRow({
  band,
  label,
  a,
  b,
}: {
  band: Band;
  label: string;
  a: ChannelReading | null;
  b: ChannelReading | null;
}) {
  return (
    <>
      <RowLabel>{label}</RowLabel>
      <EqCell testId={`mixer-a-${band}`} db={a ? a[band] : null} />
      <EqCell testId={`mixer-b-${band}`} db={b ? b[band] : null} />
    </>
  );
}

/** Rotary EQ knob plus its dB value. 12 o'clock is flat, fully left a cut/kill. */
function EqCell({ testId, db }: { testId: string; db: number | null }) {
  if (db == null) {
    return (
      <span
        data-testid={testId}
        className="text-center font-mono text-xs text-[var(--text-subtle)]"
        title="No EQ on this deck"
      >
        –
      </span>
    );
  }
  const angle = eqKnobAngle(db);
  const killed = db <= KILL_DB;
  return (
    <span
      data-testid={testId}
      data-db={db.toFixed(1)}
      className="flex items-center justify-center gap-1.5"
    >
      <svg viewBox="0 0 20 20" className="size-5 shrink-0" aria-hidden>
        <circle
          cx="10"
          cy="10"
          r="8.5"
          className="fill-[var(--surface-3)] stroke-[var(--border-strong)]"
        />
        <line
          x1="10"
          y1="10"
          x2="10"
          y2="3"
          strokeWidth="2"
          strokeLinecap="round"
          transform={`rotate(${angle} 10 10)`}
          className="stroke-[var(--text)]"
        />
      </svg>
      <span
        className={cn(
          "w-8 text-right font-mono text-xs tabular-nums",
          killed ? "text-[var(--text-subtle)]" : "text-[var(--text)]",
        )}
      >
        {killed ? "kill" : Math.round(db)}
      </span>
    </span>
  );
}

function VolumeCell({
  deck,
  reading,
}: {
  deck: "a" | "b";
  reading: ChannelReading | null;
}) {
  const volume = Math.max(0, Math.min(1, reading?.volume ?? 0));
  return (
    <span
      data-testid={`mixer-${deck}-volume`}
      data-volume={volume.toFixed(2)}
      className="flex items-center gap-1.5"
      title={`${Math.round(volume * 100)}%`}
    >
      <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--surface-3)]">
        <span
          className="block h-full rounded-full bg-[var(--brand)]"
          style={{ width: `${volume * 100}%` }}
        />
      </span>
    </span>
  );
}
