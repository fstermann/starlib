"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  MotionMultiselect,
  type MultiselectOption,
} from "@/components/ui/motion-multiselect";
import { RangeSliderField } from "@/components/ui/range-slider-field";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { TriStateCheckbox } from "@/components/ui/tri-state-checkbox";

const FAKE_GENRES: MultiselectOption[] = Array.from({ length: 50 }, (_, i) => ({
  id: `genre-${i}`,
  label:
    [
      "House",
      "Tech House",
      "Deep House",
      "Minimal",
      "Techno",
      "Melodic Techno",
      "Progressive",
      "Trance",
      "DnB",
      "Dubstep",
      "Garage",
      "Breaks",
      "Electro",
      "Ambient",
      "Downtempo",
      "Disco",
      "Nu-Disco",
      "Funk",
      "Hip-Hop",
      "Afro House",
    ][i] ?? `Genre ${i + 1}`,
}));

const FAKE_COUNTS: Record<string, number> = Object.fromEntries(
  FAKE_GENRES.map((g, i) => [g.id, Math.max(0, Math.round(200 / (i + 1)))]),
);

export function FilterPrimitivesShowcase() {
  const [selected, setSelected] = useState<string[]>([]);
  const [bpm, setBpm] = useState<[number | null, number | null]>([null, null]);
  const [inCollection, setInCollection] = useState<boolean | null>(null);

  function toggle(id: string) {
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((g) => g !== id) : [...prev, id],
    );
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-6 md:grid-cols-2">
        <div className="space-y-2">
          <div className="text-xs font-medium text-[var(--text-muted)]">
            MotionMultiselect — 50 options, selected floats to top
          </div>
          <div className="rounded-md border border-[var(--border)] bg-[var(--surface-2)] p-2">
            <MotionMultiselect
              options={FAKE_GENRES}
              selected={selected}
              onToggle={toggle}
              counts={FAKE_COUNTS}
              maxHeightClass="max-h-72"
            />
          </div>
          <div className="flex gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              onClick={() => setSelected([])}
            >
              Clear
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              onClick={() =>
                setSelected(FAKE_GENRES.slice(30, 35).map((g) => g.id))
              }
            >
              Select 5 near bottom
            </Button>
          </div>
          <p className="text-[10px] text-[var(--text-muted)]">
            Toggle an item near the bottom — the list must not jump to the top.
          </p>
        </div>

        <div className="space-y-4">
          <div className="space-y-2">
            <div className="text-xs font-medium text-[var(--text-muted)]">
              RangeSliderField
            </div>
            <div className="rounded-md border border-[var(--border)] bg-[var(--surface-2)] p-3">
              <RangeSliderField
                min={60}
                max={180}
                value={bpm}
                onCommit={(v) => setBpm(v)}
                format={(n) => `${n} BPM`}
              />
            </div>
            <div className="text-[10px] text-[var(--text-muted)]">
              Committed: {bpm[0] ?? "—"} / {bpm[1] ?? "—"}
            </div>
          </div>

          <div className="space-y-2">
            <div className="text-xs font-medium text-[var(--text-muted)]">
              TriStateCheckbox — unset / include / exclude
            </div>
            <div className="rounded-md border border-[var(--border)] bg-[var(--surface-2)] p-2">
              <TriStateCheckbox
                value={inCollection}
                onChange={setInCollection}
                label="In collection"
              />
            </div>
            <div className="text-[10px] text-[var(--text-muted)]">
              Value: {String(inCollection)}
            </div>
          </div>

          <div className="space-y-2">
            <div className="text-xs font-medium text-[var(--text-muted)]">
              Sheet — right-side drawer
            </div>
            <Sheet>
              <SheetTrigger asChild>
                <Button variant="outline" size="sm" className="h-7 text-xs">
                  Open sheet
                </Button>
              </SheetTrigger>
              <SheetContent side="right">
                <SheetHeader>
                  <SheetTitle>Filters</SheetTitle>
                  <SheetDescription>
                    Drawer hosting filter primitives.
                  </SheetDescription>
                </SheetHeader>
                <div className="flex-1 overflow-y-auto px-4 py-2">
                  <MotionMultiselect
                    options={FAKE_GENRES.slice(0, 20)}
                    selected={selected}
                    onToggle={toggle}
                    counts={FAKE_COUNTS}
                  />
                </div>
                <SheetFooter>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setSelected([])}
                  >
                    Reset
                  </Button>
                </SheetFooter>
              </SheetContent>
            </Sheet>
          </div>
        </div>
      </div>
    </div>
  );
}
