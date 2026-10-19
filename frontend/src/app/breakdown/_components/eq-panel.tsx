"use client";

import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Toggle } from "@/components/ui/toggle";

import type { PreviewEq } from "../_hooks/use-preview-eq";

const LOW_HZ = 20;
const HIGH_HZ = 20000;
// The frequency slider moves in log steps, like an EQ's frequency knob.
const FREQ_STEPS = 1000;

function freqToStep(hz: number): number {
  return (Math.log(hz / LOW_HZ) / Math.log(HIGH_HZ / LOW_HZ)) * FREQ_STEPS;
}

function stepToFreq(step: number): number {
  return Math.round(LOW_HZ * (HIGH_HZ / LOW_HZ) ** (step / FREQ_STEPS));
}

function formatHz(hz: number): string {
  return hz >= 1000 ? `${(hz / 1000).toFixed(2)} kHz` : `${hz} Hz`;
}

function formatGain(db: number): string {
  return `${db > 0 ? "+" : ""}${db.toFixed(1)} dB`;
}

/** A bell EQ on the set player, with its settings spelled out for Ableton's EQ Eight. */
export function EqPanel({ preview }: { preview: PreviewEq }) {
  const { eq, setEq, reset } = preview;
  return (
    <section
      className="border-border bg-surface-2 flex flex-col gap-3 rounded-lg border p-4"
      data-testid="eq-panel"
    >
      <header className="flex items-center justify-between gap-2">
        <h2 className="text-text text-sm font-semibold">EQ preview</h2>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="text-text-muted hover:text-text h-7"
            onClick={reset}
            data-testid="eq-reset"
          >
            Reset
          </Button>
          <Toggle
            variant="outline"
            pressed={eq.on}
            onPressedChange={(on) => setEq({ on })}
            className="data-[state=on]:bg-brand-soft data-[state=on]:text-brand w-14"
            aria-label="EQ on"
            data-testid="eq-toggle"
          >
            {eq.on ? "On" : "Off"}
          </Toggle>
        </div>
      </header>
      <p className="text-text-subtle text-xs">
        A bell on the set while it plays. Switch it off and on to compare. With
        a reference picked, Compare shows the tonal balance it would give.
      </p>
      <Control
        label="Frequency"
        value={formatHz(eq.freqHz)}
        testId="eq-frequency"
      >
        <Slider
          min={0}
          max={FREQ_STEPS}
          step={1}
          value={[freqToStep(eq.freqHz)]}
          onValueChange={([step]) => setEq({ freqHz: stepToFreq(step) })}
          aria-label="Frequency"
        />
      </Control>
      <Control label="Gain" value={formatGain(eq.gainDb)} testId="eq-gain">
        <Slider
          min={-6}
          max={6}
          step={0.1}
          value={[eq.gainDb]}
          onValueChange={([gainDb]) =>
            setEq({ gainDb: Math.round(gainDb * 10) / 10 })
          }
          aria-label="Gain"
        />
      </Control>
      <Control label="Q" value={eq.q.toFixed(2)} testId="eq-q">
        <Slider
          min={0.1}
          max={4}
          step={0.05}
          value={[eq.q]}
          onValueChange={([q]) => setEq({ q: Math.round(q * 100) / 100 })}
          aria-label="Q"
        />
      </Control>
      <p
        className="border-border text-text-muted border-t pt-3 text-xs"
        data-testid="eq-ableton"
      >
        In Ableton&apos;s EQ Eight: <span className="text-text">Bell</span>,{" "}
        <span className="text-text tabular-nums">
          {formatHz(eq.freqHz)}, {formatGain(eq.gainDb)}, Q {eq.q.toFixed(2)}
        </span>
        . EQs define Q differently, so match the width by ear.
      </p>
    </section>
  );
}

function Control({
  label,
  value,
  testId,
  children,
}: {
  label: string;
  value: string;
  testId: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5" data-testid={`${testId}-control`}>
      <div className="flex items-baseline justify-between text-xs">
        <span className="text-text-muted">{label}</span>
        <span className="text-text tabular-nums" data-testid={testId}>
          {value}
        </span>
      </div>
      {children}
    </div>
  );
}
