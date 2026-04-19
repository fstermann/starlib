"use client";

import { useState } from "react";

import { FiltersToolbar } from "@/components/filters/filters-toolbar";
import {
  emptyStateFor,
  type FilterSchemaResponse,
  type FilterState,
  type FilterValue,
} from "@/lib/filters/schema";

const FIXTURE_SCHEMA: FilterSchemaResponse = {
  source: "design.sample",
  attributes: [
    {
      id: "search",
      label: "Search",
      kind: "text",
    },
    {
      id: "genre",
      label: "Genre",
      kind: "enum",
      options: [
        "House",
        "Tech House",
        "Deep House",
        "Techno",
        "Melodic Techno",
        "Progressive",
        "Trance",
        "DnB",
        "Ambient",
        "Downtempo",
      ],
      counts: {
        House: 142,
        "Tech House": 98,
        "Deep House": 76,
        Techno: 64,
        "Melodic Techno": 41,
        Progressive: 22,
        Trance: 18,
        DnB: 12,
        Ambient: 6,
        Downtempo: 0,
      },
    },
    {
      id: "key",
      label: "Key",
      kind: "enum",
      sortHint: "camelot",
      options: [
        "1A",
        "1B",
        "2A",
        "2B",
        "3A",
        "3B",
        "4A",
        "4B",
        "5A",
        "5B",
        "6A",
        "6B",
      ],
      counts: {
        "1A": 12,
        "1B": 8,
        "2A": 15,
        "2B": 11,
        "3A": 9,
        "3B": 7,
        "4A": 14,
        "4B": 10,
        "5A": 6,
        "5B": 5,
        "6A": 4,
        "6B": 2,
      },
    },
    {
      id: "bpm",
      label: "BPM",
      kind: "range",
      min: 60,
      max: 180,
      step: 1,
      formatHint: "bpm",
    },
    {
      id: "duration",
      label: "Duration",
      kind: "range",
      min: 0,
      max: 1800,
      step: 30,
      formatHint: "duration",
    },
    {
      id: "in_collection",
      label: "In collection",
      kind: "bool",
    },
    {
      id: "mood",
      label: "Mood",
      kind: "enum",
      options: ["Dark", "Uplifting", "Dreamy", "Aggressive", "Chill"],
      counts: { Dark: 24, Uplifting: 18, Dreamy: 12, Aggressive: 9, Chill: 15 },
    },
    {
      id: "experimental_tag",
      label: "Experimental tag",
      kind: "text",
    },
  ],
};

export function FiltersToolbarShowcase() {
  const [state, setState] = useState<FilterState>(
    emptyStateFor(FIXTURE_SCHEMA),
  );

  function handleChange(id: string, value: FilterValue) {
    setState((prev) => ({ ...prev, [id]: value }));
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-[var(--text-muted)]">
        Schema-driven toolbar. Toggle Filters to expand the panel below it.
        Unknown attributes (like{" "}
        <code className="font-mono">experimental_tag</code>) fall through to a
        generic text input — backend-driven attributes work out of the box.
      </p>
      <div className="overflow-hidden rounded-md border border-[var(--border)]">
        <FiltersToolbar
          schema={FIXTURE_SCHEMA}
          state={state}
          onChange={handleChange}
          filtered={472}
          total={5678}
          defaultOpen
        />
        <div className="bg-[var(--surface-1)] p-6 text-center text-xs text-[var(--text-muted)]">
          Table would render here.
        </div>
      </div>
    </div>
  );
}
