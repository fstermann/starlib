"use client";

import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { Archive, Loader2, MoveRight, Plus, RefreshCw } from "lucide-react";
import React, { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  REQUIRED_ATTRIBUTES,
  RULE_OUTPUTS,
  type RequiredAttribute,
  type Rule,
  type Ruleset,
  type RuleType,
} from "@/lib/api";
import { getSetting } from "@/lib/settings";
import { cn } from "@/lib/utils";

import { RULE_ICON_COLORS, RuleCard, type InputOption } from "./rule-card";

const RULE_TYPE_META: {
  type: RuleType;
  label: string;
  icon: React.ElementType;
}[] = [
  { type: "convert", label: "Convert format", icon: RefreshCw },
  { type: "copy", label: "Copy to folder", icon: Archive },
  { type: "move", label: "Move to folder", icon: MoveRight },
];

// Only copy/move can be nested under a convert (no nested converts)
const BRANCH_RULE_META = RULE_TYPE_META.filter((m) => m.type !== "convert");

const RULE_TYPE_LABEL: Record<RuleType, string> = {
  convert: "Convert",
  copy: "Copy",
  move: "Move",
};

interface RulesetEditorProps {
  ruleset: Ruleset;
  onChange: (updated: Ruleset) => void;
  onSave?: () => void;
  saving?: boolean;
  hasPendingEdit?: boolean;
}

const DEFAULT_PARAMS: Record<RuleType, Rule["params"]> = {
  convert: { format: "preferred", quality: 320 },
  copy: { folder: "archive" },
  move: { folder: "cleaned" },
};

function nextRuleId(existing: Rule[], type: RuleType): string {
  const base = type;
  const taken = new Set(existing.map((r) => r.id));
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base}${i}`)) i++;
  return `${base}${i}`;
}

function inputOptionsFor(rules: Rule[], idx: number): InputOption[] {
  const opts: InputOption[] = [
    {
      ref: "source",
      sourceStep: null,
      sourceVerb: null,
      sourceType: null,
      outputName: null,
    },
  ];
  for (let i = 0; i < idx; i++) {
    const r = rules[i];
    for (const name of RULE_OUTPUTS[r.type] ?? []) {
      opts.push({
        ref: `${r.id}.${name}`,
        sourceStep: i + 1,
        sourceVerb: RULE_TYPE_LABEL[r.type],
        sourceType: r.type,
        outputName: name,
      });
    }
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Segment grouping: each convert rule absorbs rules that are *conditionally*
// gated on its output (i.e. have `requires` referencing it). Non-conditional
// rules that merely reference the convert's output remain standalone.
// ---------------------------------------------------------------------------

type Segment =
  | { kind: "standalone"; ruleIdx: number }
  | { kind: "convert-group"; convertIdx: number; branchIdxs: number[] };

/** Does `rule` reference any output of `convertId` via `requires`? */
function conditionalOnConvert(rule: Rule, convertId: string): boolean {
  const prefix = `${convertId}.`;
  return (rule.requires ?? []).some((ref) => ref.startsWith(prefix));
}

/** Does `rule` reference any output of `convertId` at all (input or requires)? */
function referencesConvert(rule: Rule, convertId: string): boolean {
  const prefix = `${convertId}.`;
  if (rule.input.startsWith(prefix)) return true;
  return (rule.requires ?? []).some((ref) => ref.startsWith(prefix));
}

function buildSegments(rules: Rule[]): Segment[] {
  // Mark rules that are conditionally gated on a convert's output.
  const absorbed = new Set<number>();
  for (let i = 0; i < rules.length; i++) {
    if (rules[i].type !== "convert") continue;
    const convertId = rules[i].id;
    let j = i + 1;
    // Scan while rules still reference this convert (skip non-conditional ones).
    while (j < rules.length && referencesConvert(rules[j], convertId)) {
      if (conditionalOnConvert(rules[j], convertId)) absorbed.add(j);
      j++;
    }
  }

  const result: Segment[] = [];
  for (let i = 0; i < rules.length; i++) {
    if (absorbed.has(i)) continue;
    const rule = rules[i];
    if (rule.type === "convert") {
      const prefix = `${rule.id}.`;
      const branchIdxs = [...absorbed]
        .filter(
          (j) =>
            j > i &&
            (rules[j].requires ?? []).some((r) => r.startsWith(prefix)),
        )
        .sort((a, b) => a - b);
      result.push({ kind: "convert-group", convertIdx: i, branchIdxs });
    } else {
      result.push({ kind: "standalone", ruleIdx: i });
    }
  }
  return result;
}

export function RulesetEditor({
  ruleset,
  onChange,
  onSave,
  saving,
  hasPendingEdit,
}: RulesetEditorProps) {
  const [preferredFormat, setPreferredFormat] = useState("aiff");
  const rules = ruleset.rules;

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  useEffect(() => {
    getSetting("preferredOutputFormat").then(setPreferredFormat);
    function onFormatChanged(e: Event) {
      setPreferredFormat((e as CustomEvent<string>).detail);
    }
    window.addEventListener("preferred-format-changed", onFormatChanged);
    return () =>
      window.removeEventListener("preferred-format-changed", onFormatChanged);
  }, []);

  const segments = useMemo(() => buildSegments(rules), [rules]);

  // One sortable id per segment (convert-group uses the convert's id)
  const sortableSegmentIds = segments.map((s) =>
    s.kind === "standalone" ? rules[s.ruleIdx].id : rules[s.convertIdx].id,
  );

  function publishRules(newRules: Rule[]) {
    onChange({ ...ruleset, rules: newRules });
  }

  function sanitize(newRules: Rule[]): Rule[] {
    return newRules.map((rule, idx) => {
      const allowed = new Set<string>(["source"]);
      for (let i = 0; i < idx; i++) {
        const earlier = newRules[i];
        for (const name of RULE_OUTPUTS[earlier.type] ?? []) {
          allowed.add(`${earlier.id}.${name}`);
        }
      }
      let next = rule;
      if (!allowed.has(rule.input)) next = { ...next, input: "source" };
      const req = (rule.requires ?? []).filter((ref) => allowed.has(ref));
      if (req.length !== (rule.requires?.length ?? 0))
        next = { ...next, requires: req };
      return next;
    });
  }

  /** Flatten segments back to a rule array in order. */
  function flattenSegments(segs: Segment[], src: Rule[]): Rule[] {
    return segs.flatMap((s) =>
      s.kind === "standalone"
        ? [src[s.ruleIdx]]
        : [src[s.convertIdx], ...s.branchIdxs.map((i) => src[i])],
    );
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIdx = sortableSegmentIds.indexOf(String(active.id));
    const newIdx = sortableSegmentIds.indexOf(String(over.id));
    if (oldIdx === -1 || newIdx === -1) return;
    const reordered = arrayMove(segments, oldIdx, newIdx);
    publishRules(sanitize(flattenSegments(reordered, rules)));
  }

  function handleRuleChange(ruleIdx: number, updated: Rule) {
    publishRules(rules.map((r, i) => (i === ruleIdx ? updated : r)));
  }

  function handleDeleteStandalone(ruleIdx: number) {
    const removedId = rules[ruleIdx].id;
    const prefix = `${removedId}.`;
    const remaining = rules
      .filter((_, i) => i !== ruleIdx)
      .map((r) => {
        let next = r;
        if (r.input.startsWith(prefix)) next = { ...next, input: "source" };
        if ((r.requires ?? []).some((ref) => ref.startsWith(prefix)))
          next = {
            ...next,
            requires: (r.requires ?? []).filter(
              (ref) => !ref.startsWith(prefix),
            ),
          };
        return next;
      });
    publishRules(sanitize(remaining));
  }

  /** Delete a convert group — removes the convert AND all its branch rules. */
  function handleDeleteConvertGroup(convertIdx: number, branchIdxs: number[]) {
    const toRemove = new Set([convertIdx, ...branchIdxs]);
    const removedIds = new Set([...toRemove].map((i) => rules[i].id));
    const remaining = rules
      .filter((_, i) => !toRemove.has(i))
      .map((r) => {
        let next = r;
        for (const rid of removedIds) {
          const prefix = `${rid}.`;
          if (next.input.startsWith(prefix))
            next = { ...next, input: "source" };
          if ((next.requires ?? []).some((ref) => ref.startsWith(prefix)))
            next = {
              ...next,
              requires: (next.requires ?? []).filter(
                (ref) => !ref.startsWith(prefix),
              ),
            };
        }
        return next;
      });
    publishRules(sanitize(remaining));
  }

  /** Delete a single branch rule from a convert group. */
  function handleDeleteBranch(branchIdx: number) {
    handleDeleteStandalone(branchIdx);
  }

  function handleAddRule(type: RuleType) {
    const id = nextRuleId(rules, type);
    publishRules([
      ...rules,
      {
        id,
        type,
        input: "source",
        requires: [],
        params: { ...DEFAULT_PARAMS[type] },
      },
    ]);
  }

  /** Add an "if converted" step (gated on convert.converted). */
  function handleAddConditionalStep(
    convertId: string,
    convertIdx: number,
    branchIdxs: number[],
    type: RuleType,
  ) {
    const id = nextRuleId(rules, type);
    const newRule: Rule = {
      id,
      type,
      input: `${convertId}.original`,
      requires: [`${convertId}.converted`],
      params: { ...DEFAULT_PARAMS[type] },
    };
    const insertIdx =
      branchIdxs.length > 0
        ? branchIdxs[branchIdxs.length - 1] + 1
        : convertIdx + 1;
    publishRules([
      ...rules.slice(0, insertIdx),
      newRule,
      ...rules.slice(insertIdx),
    ]);
  }

  // ---- Render sub-panel: only "if converted" (conditional) steps -----------

  function renderBranchPanel(
    convertIdx: number,
    convertId: string,
    branchIdxs: number[],
  ) {
    // No panel needed for built-in rulesets with no conditional steps.
    if (branchIdxs.length === 0 && ruleset.is_builtin) return null;

    return (
      <div className="flex flex-col gap-1.5 px-2 pt-1 pb-2">
        <div className="flex items-center gap-2">
          <span className="bg-info/15 h-px flex-1" />
          <span className="text-info/60 text-xs font-semibold">
            if converted
          </span>
          <span className="bg-info/15 h-px flex-1" />
        </div>
        <div
          className={cn(
            "flex flex-col gap-1.5 rounded-md p-1.5",
            branchIdxs.length > 0 && "border-info/15 bg-info/4 border",
          )}
        >
          {branchIdxs.map((bIdx) => {
            const bRule = rules[bIdx];
            return (
              <RuleCard
                key={bRule.id}
                id={bRule.id}
                rule={bRule}
                step={bIdx + 1}
                draggable={false}
                isBuiltin={ruleset.is_builtin}
                preferredFormat={preferredFormat}
                inputOptions={inputOptionsFor(rules, bIdx)}
                onChange={(updated) => handleRuleChange(bIdx, updated)}
                onDelete={() => handleDeleteBranch(bIdx)}
              />
            );
          })}
          {branchIdxs.length === 0 && (
            <p className="text-muted-foreground px-1.5 py-0.5 text-xs">
              No steps yet.
            </p>
          )}
          {!ruleset.is_builtin && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-info/60 hover:text-info hover:bg-info/10 h-7 w-fit cursor-pointer gap-1.5 text-xs"
                >
                  <Plus className="size-3" />
                  Add on success
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-44">
                {BRANCH_RULE_META.map(({ type, label, icon: Icon }) => (
                  <DropdownMenuItem
                    key={type}
                    className="cursor-pointer gap-2.5"
                    onClick={() =>
                      handleAddConditionalStep(
                        convertId,
                        convertIdx,
                        branchIdxs,
                        type,
                      )
                    }
                  >
                    <Icon
                      className={cn("size-4 shrink-0", RULE_ICON_COLORS[type])}
                    />
                    {label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>
    );
  }

  // ---- Main render -----------------------------------------------------------

  return (
    <div className="flex flex-col gap-4">
      {!ruleset.is_builtin ? (
        <div className="flex flex-col gap-1.5">
          <Label className="text-sm">Name</Label>
          <Input
            value={ruleset.name}
            className="h-8"
            onChange={(e) => onChange({ ...ruleset, name: e.target.value })}
          />
        </div>
      ) : (
        <p className="text-muted-foreground text-xs">
          Built-in ruleset — read only.
        </p>
      )}

      <div className="flex flex-col gap-1.5">
        <Label className="text-sm">Workflow</Label>
        {rules.length === 0 && (
          <p className="text-muted-foreground py-1 text-xs">
            No rules yet — add one below.
          </p>
        )}
        {rules.length > 0 && (
          <div className="border-border bg-muted rounded-lg border p-2">
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleDragEnd}
            >
              <SortableContext
                items={sortableSegmentIds}
                strategy={verticalListSortingStrategy}
              >
                <div className="flex flex-col gap-1.5">
                  {segments.map((seg) => {
                    if (seg.kind === "standalone") {
                      const rule = rules[seg.ruleIdx];
                      return (
                        <RuleCard
                          key={rule.id}
                          id={rule.id}
                          rule={rule}
                          step={seg.ruleIdx + 1}
                          isBuiltin={ruleset.is_builtin}
                          preferredFormat={preferredFormat}
                          inputOptions={inputOptionsFor(rules, seg.ruleIdx)}
                          onChange={(updated) =>
                            handleRuleChange(seg.ruleIdx, updated)
                          }
                          onDelete={() => handleDeleteStandalone(seg.ruleIdx)}
                        />
                      );
                    }
                    // convert-group
                    const convRule = rules[seg.convertIdx];
                    return (
                      <RuleCard
                        key={convRule.id}
                        id={convRule.id}
                        rule={convRule}
                        step={seg.convertIdx + 1}
                        isBuiltin={ruleset.is_builtin}
                        preferredFormat={preferredFormat}
                        inputOptions={inputOptionsFor(rules, seg.convertIdx)}
                        onChange={(updated) =>
                          handleRuleChange(seg.convertIdx, updated)
                        }
                        onDelete={() =>
                          handleDeleteConvertGroup(
                            seg.convertIdx,
                            seg.branchIdxs,
                          )
                        }
                        subPanel={renderBranchPanel(
                          seg.convertIdx,
                          convRule.id,
                          seg.branchIdxs,
                        )}
                      />
                    );
                  })}
                </div>
              </SortableContext>
            </DndContext>
          </div>
        )}
      </div>

      <RequiredAttributesPicker
        value={ruleset.required_attributes ?? []}
        disabled={ruleset.is_builtin}
        onChange={(next) => onChange({ ...ruleset, required_attributes: next })}
      />

      {!ruleset.is_builtin && (
        <div className="flex items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="w-fit cursor-pointer"
              >
                <Plus className="size-3.5" />
                Add rule
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-48">
              {RULE_TYPE_META.map(({ type, label, icon: Icon }) => (
                <DropdownMenuItem
                  key={type}
                  className="cursor-pointer gap-2.5"
                  onClick={() => handleAddRule(type)}
                >
                  <Icon
                    className={cn("size-4 shrink-0", RULE_ICON_COLORS[type])}
                  />
                  {label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          {hasPendingEdit && onSave && (
            <Button size="sm" onClick={onSave} disabled={saving}>
              {saving && <Loader2 className="size-3.5 animate-spin" />}
              Save changes
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

const REQUIRED_ATTR_LABEL: Record<RequiredAttribute, string> = {
  title: "Title",
  artist: "Artist",
  genre: "Genre",
  bpm: "BPM",
  key: "Key",
  release_date: "Release date",
  remixer: "Remixer",
  comment: "Comment",
  artwork: "Artwork",
};

interface RequiredAttributesPickerProps {
  value: RequiredAttribute[];
  disabled: boolean;
  onChange: (next: RequiredAttribute[]) => void;
}

function RequiredAttributesPicker({
  value,
  disabled,
  onChange,
}: RequiredAttributesPickerProps) {
  const selected = new Set(value);
  function toggle(attr: RequiredAttribute) {
    const next = new Set(selected);
    if (next.has(attr)) next.delete(attr);
    else next.add(attr);
    // Preserve canonical order from REQUIRED_ATTRIBUTES
    onChange(REQUIRED_ATTRIBUTES.filter((a) => next.has(a)));
  }
  return (
    <div className="flex flex-col gap-1.5">
      <Label className="text-sm">Required attributes</Label>
      <p className="text-muted-foreground text-xs">
        Tracks missing any of these can&apos;t be finalized with this ruleset.
        The Apply Rules button will list what&apos;s missing.
      </p>
      <div className="flex flex-wrap gap-1.5 pt-0.5">
        {REQUIRED_ATTRIBUTES.map((attr) => {
          const isOn = selected.has(attr);
          return (
            <button
              key={attr}
              type="button"
              disabled={disabled}
              onClick={() => toggle(attr)}
              className={cn(
                "rounded-full border px-2 py-0.5 text-xs transition-colors",
                isOn
                  ? "bg-brand-soft border-primary/40 text-foreground"
                  : "border-border text-muted-foreground hover:text-foreground bg-transparent",
                disabled && "cursor-not-allowed opacity-60",
                !disabled && "cursor-pointer",
              )}
            >
              {REQUIRED_ATTR_LABEL[attr]}
            </button>
          );
        })}
      </div>
    </div>
  );
}
