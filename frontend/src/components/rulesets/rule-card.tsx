"use client";

import React, { useState } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Archive, GripVertical, MoveRight, RefreshCw, Trash2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { type Rule, type RuleType } from "@/lib/api";

export const RULE_ICONS: Record<RuleType, React.ElementType> = {
  convert: RefreshCw,
  copy: Archive,
  move: MoveRight,
};

export const RULE_ICON_COLORS: Record<RuleType, string> = {
  convert: "text-info",
  copy: "text-warning",
  move: "text-success",
};

const FOLDER_PRESETS = ["cleaned", "archive", "prepare", "collection"];

/** A reference a rule can consume. */
export interface InputOption {
  ref: string;
  sourceStep: number | null;
  sourceVerb: string | null;
  sourceType: RuleType | null;
  outputName: string | null;
}

function FolderChip({
  value,
  disabled,
  onChange,
  color,
}: {
  value: string;
  disabled: boolean;
  onChange: (v: string) => void;
  color: "green" | "amber";
}) {
  const [open, setOpen] = useState(false);
  const [local, setLocal] = useState(value);

  const colorClass =
    color === "green"
      ? "bg-success/10 text-success dark:text-success border-success/25 hover:bg-success/18"
      : "bg-warning/10 text-warning dark:text-warning border-warning/25 hover:bg-warning/18";

  const inner = (
    <span className="font-mono">
      {value}
      <span className="opacity-50">/</span>
    </span>
  );

  if (disabled) {
    return (
      <span
        className={cn(
          "inline-flex items-center rounded border px-1.5 py-0.5 text-xs font-medium",
          colorClass.split(" hover:")[0]
        )}
      >
        {inner}
      </span>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          onClick={() => setLocal(value)}
          className={cn(
            "inline-flex cursor-pointer items-center rounded border px-1.5 py-0.5 text-xs font-medium transition-colors",
            colorClass
          )}
        >
          {inner}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-40 p-2 flex flex-col gap-2" align="start">
        <Input
          className="h-7 text-xs font-mono"
          value={local}
          autoFocus
          onChange={(e) => setLocal(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") { onChange(local); setOpen(false); }
            if (e.key === "Escape") setOpen(false);
          }}
        />
        <div className="flex flex-wrap gap-1">
          {FOLDER_PRESETS.map((p) => (
            <button
              key={p}
              className="cursor-pointer rounded bg-accent px-1.5 py-0.5 text-xs font-mono text-accent-foreground transition-colors hover:bg-accent"
              onClick={() => { onChange(p); setOpen(false); }}
            >
              {p}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function FormatChip({
  format,
  quality,
  disabled,
  preferredFormat,
  onFormatChange,
  onQualityChange,
}: {
  format: string;
  quality: number;
  disabled: boolean;
  preferredFormat?: string;
  onFormatChange: (v: string) => void;
  onQualityChange: (v: number) => void;
}) {
  const [open, setOpen] = useState(false);

  const base = "bg-info/10 text-info dark:text-info border-info/25";

  const isPreferred = format === "preferred";
  const displayFormat = isPreferred ? (preferredFormat ?? "aiff") : format;

  const label = (
    <>
      <span className="font-mono">{displayFormat.toUpperCase()}</span>
      {displayFormat === "mp3" && !isPreferred && (
        <span className="ml-1 opacity-50 font-mono">{quality}k</span>
      )}
      {isPreferred && (
        <span className="ml-1 rounded bg-brand-soft px-1 text-xs font-semibold tracking-wide text-primary">
          preferred
        </span>
      )}
    </>
  );

  if (disabled) {
    return (
      <span className={cn("inline-flex items-center rounded border px-1.5 py-0.5 text-xs font-medium", base)}>
        {label}
      </span>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className={cn(
            "inline-flex cursor-pointer items-center rounded border px-1.5 py-0.5 text-xs font-medium transition-colors hover:bg-info/18",
            base
          )}
        >
          {label}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-44 p-2 flex flex-col gap-2" align="start">
        {preferredFormat && (
          <button
            className={cn(
              "w-full cursor-pointer rounded border px-2 py-1 text-xs font-medium transition-colors text-left flex items-center justify-between",
              isPreferred
                ? "bg-brand-soft text-primary border-primary/20"
                : "bg-accent text-accent-foreground border-transparent hover:bg-accent"
            )}
            onClick={() => { onFormatChange("preferred"); setOpen(false); }}
          >
            <span>Preferred</span>
            <span className="font-mono opacity-60">{preferredFormat.toUpperCase()}</span>
          </button>
        )}
        <div className="flex gap-1.5">
          {["aiff", "mp3"].map((f) => (
            <button
              key={f}
              className={cn(
                "flex-1 cursor-pointer rounded border px-2 py-1 text-xs font-mono font-medium transition-colors",
                format === f
                  ? "bg-primary text-primary-foreground border-primary"
                  : "bg-accent text-accent-foreground border-transparent hover:bg-accent"
              )}
              onClick={() => { onFormatChange(f); setOpen(false); }}
            >
              {f.toUpperCase()}
            </button>
          ))}
        </div>
        {format === "mp3" && (
          <div className="flex flex-col gap-1">
            <span className="text-xs tracking-wide text-muted-foreground">Bitrate</span>
            <div className="flex gap-1">
              {[128, 192, 256, 320].map((q) => (
                <button
                  key={q}
                  className={cn(
                    "flex-1 cursor-pointer rounded border px-1 py-1 text-xs font-mono transition-colors",
                    quality === q
                      ? "bg-primary text-primary-foreground border-primary"
                      : "bg-accent text-accent-foreground border-transparent hover:bg-accent"
                  )}
                  onClick={() => onQualityChange(q)}
                >
                  {q}k
                </button>
              ))}
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

export function StepBadge({ step, type, className }: { step: number; type: RuleType; className?: string }) {
  const bg: Record<RuleType, string> = {
    convert: "bg-info/15 text-info dark:text-info border-info/30",
    copy:    "bg-warning/15 text-warning dark:text-warning border-warning/30",
    move:    "bg-success/15 text-success dark:text-success border-success/30",
  };
  return (
    <span
      className={cn(
        "inline-flex size-4 shrink-0 items-center justify-center rounded-full border text-xs font-bold tabular-nums",
        bg[type],
        className
      )}
    >
      {step}
    </span>
  );
}

function InputChipBody({ option }: { option: InputOption | undefined }) {
  if (!option || option.sourceStep == null || !option.sourceType) {
    return (
      <span className="inline-flex items-center gap-1.5">
        <span className="size-4 shrink-0 rounded-full border border-dashed border-muted-foreground/40" />
        Source file
      </span>
    );
  }
  const SourceIcon = RULE_ICONS[option.sourceType];
  return (
    <span className="inline-flex items-center gap-1.5">
      <StepBadge step={option.sourceStep} type={option.sourceType} />
      <SourceIcon className={cn("size-3 shrink-0", RULE_ICON_COLORS[option.sourceType])} />
      <span>{option.outputName}</span>
    </span>
  );
}

function InputPicker({
  value,
  options,
  disabled,
  onChange,
}: {
  value: string;
  options: InputOption[];
  disabled: boolean;
  onChange: (ref: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const selected = options.find((o) => o.ref === value);
  const isSource = !selected || selected.sourceStep == null;

  const baseClass = cn(
    "inline-flex items-center rounded-md border px-2 py-1 text-xs transition-colors",
    isSource
      ? "bg-muted text-muted-foreground border-border"
      : "bg-card text-foreground border-border"
  );

  if (disabled) {
    return (
      <span className={baseClass}>
        <InputChipBody option={selected} />
      </span>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button className={cn(baseClass, "cursor-pointer hover:bg-accent")}>
          <InputChipBody option={selected} />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-1" align="start">
        <div className="flex flex-col gap-0.5">
          {options.map((opt) => {
            const active = opt.ref === value;
            return (
              <button
                key={opt.ref}
                className={cn(
                  "cursor-pointer rounded px-2 py-1.5 text-left text-xs transition-colors",
                  active ? "bg-brand-soft text-primary" : "hover:bg-accent text-foreground"
                )}
                onClick={() => { onChange(opt.ref); setOpen(false); }}
              >
                <InputChipBody option={opt} />
              </button>
            );
          })}
          {options.length === 0 && (
            <div className="px-2 py-1.5 text-xs text-muted-foreground">No earlier outputs available.</div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

interface RuleCardProps {
  id: string;
  rule: Rule;
  step: number;
  isBuiltin: boolean;
  preferredFormat?: string;
  draggable?: boolean;
  inputOptions: InputOption[];
  /** Rendered below the main row when the card wraps child rules. */
  subPanel?: React.ReactNode;
  onChange: (rule: Rule) => void;
  onDelete: () => void;
}

export function RuleCard({
  id,
  rule,
  step,
  isBuiltin,
  preferredFormat,
  draggable = true,
  inputOptions,
  subPanel,
  onChange,
  onDelete,
}: RuleCardProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });

  const style = draggable ? { transform: CSS.Transform.toString(transform), transition } : {};
  const Icon = RULE_ICONS[rule.type] ?? Archive;

  function setParam(key: string, value: unknown) {
    onChange({ ...rule, params: { ...rule.params, [key]: value } });
  }

  const verb: Record<RuleType, string> = { convert: "Convert", copy: "Copy", move: "Move" };

  const inputPicker = (
    <InputPicker
      value={rule.input}
      options={inputOptions}
      disabled={isBuiltin}
      onChange={(ref) => onChange({ ...rule, input: ref })}
    />
  );

  const destination =
    rule.type === "convert" ? (
      <FormatChip
        format={String(rule.params.format ?? "aiff")}
        quality={Number(rule.params.quality ?? 320)}
        disabled={isBuiltin}
        preferredFormat={preferredFormat}
        onFormatChange={(v) => setParam("format", v)}
        onQualityChange={(v) => setParam("quality", v)}
      />
    ) : rule.type === "move" ? (
      <FolderChip
        value={String(rule.params.folder ?? "cleaned")}
        disabled={isBuiltin}
        color="green"
        onChange={(v) => setParam("folder", v)}
      />
    ) : (
      <FolderChip
        value={String(rule.params.folder ?? "archive")}
        disabled={isBuiltin}
        color="amber"
        onChange={(v) => setParam("folder", v)}
      />
    );

  return (
    <div
      ref={draggable ? setNodeRef : undefined}
      style={style}
      className={cn(
        "group rounded-md border border-border bg-card",
        isDragging && "opacity-50 shadow-lg"
      )}
    >
      <div className="flex items-center gap-2 px-2.5 py-2 text-xs">
        {/* Drag handle */}
        <button
          {...(draggable ? { ...attributes, ...listeners } : {})}
          tabIndex={-1}
          className={cn(
            "shrink-0 text-muted-foreground transition-colors group-hover:text-muted-foreground",
            isBuiltin || !draggable
              ? "pointer-events-none cursor-default opacity-30"
              : "cursor-grab active:cursor-grabbing"
          )}
        >
          <GripVertical className="size-3.5" />
        </button>

        <StepBadge step={step} type={rule.type} />

        <div className="flex shrink-0 items-center gap-1.5 min-w-18">
          <Icon className={cn("size-3.5 shrink-0", RULE_ICON_COLORS[rule.type] ?? "text-muted-foreground")} />
          <span className="font-medium text-foreground">{verb[rule.type]}</span>
        </div>

        <div className="flex shrink-0 items-center">
          {inputPicker}
        </div>

        <span className="shrink-0 text-muted-foreground">to</span>

        <div className="flex flex-1 items-center">
          {destination}
        </div>

        {!isBuiltin && (
          <button
            onClick={onDelete}
            className="shrink-0 cursor-pointer text-muted-foreground transition-colors group-hover:text-muted-foreground hover:text-destructive!"
            aria-label="Remove rule"
          >
            <Trash2 className="size-3.5" />
          </button>
        )}
      </div>
      {subPanel && (
        <div className="border-t border-border">
          {subPanel}
        </div>
      )}
    </div>
  );
}
