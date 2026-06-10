"use client";

import { Download, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { useCommand } from "@/components/command-palette/use-command";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { api, type FetchCandidate } from "@/lib/api";
import { cn } from "@/lib/utils";

interface FetchFromDownloadsButtonProps {
  /** Tree-selected destination folder. Button is disabled when undefined. */
  folderPath?: string;
  /** Bumped after a successful fetch so the table reloads. */
  onComplete?: () => void;
  className?: string;
}

const PRESETS = ["1", "3", "7"] as const;

export function FetchFromDownloadsButton({
  folderPath,
  onComplete,
  className,
}: FetchFromDownloadsButtonProps) {
  const [open, setOpen] = useState(false);
  const [preset, setPreset] = useState<string>("1");
  const [customDays, setCustomDays] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [candidates, setCandidates] = useState<FetchCandidate[]>([]);
  const [skipped, setSkipped] = useState<string[]>([]);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const disabled = !folderPath;

  const resolvedDays = (() => {
    const raw = preset === "custom" ? customDays : preset;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n >= 1 ? n : null;
  })();

  // Fetch the preview whenever the dialog is open and we have a valid window.
  useEffect(() => {
    if (!open || !folderPath || resolvedDays === null) return;
    const ctrl = new AbortController();
    setPreviewLoading(true);
    setPreviewError(null);
    api
      .fetchFromDownloadsPreview(folderPath, resolvedDays, ctrl.signal)
      .then((res) => {
        setCandidates(res.candidates);
        setSkipped(res.skipped);
        setExcluded(new Set());
      })
      .catch((err: unknown) => {
        if ((err as { name?: string })?.name === "AbortError") return;
        setPreviewError(
          err instanceof Error ? err.message : "Failed to load preview",
        );
        setCandidates([]);
        setSkipped([]);
      })
      .finally(() => setPreviewLoading(false));
    return () => ctrl.abort();
  }, [open, folderPath, resolvedDays]);

  const selected = candidates.filter((c) => !excluded.has(c.name));
  const selectedCount = selected.length;

  const handleFetch = useCallback(async () => {
    if (!folderPath || resolvedDays === null) {
      toast.error("Enter a positive number of days");
      return;
    }
    if (selectedCount === 0) {
      toast.message("Nothing selected");
      return;
    }
    setBusy(true);
    try {
      const result = await api.fetchFromDownloads(
        folderPath,
        resolvedDays,
        selected.map((c) => c.name),
      );
      const movedN = result.moved.length;
      const skippedN = result.skipped.length;
      const errorN = result.errors.length;
      const summary =
        movedN === 0
          ? skippedN > 0
            ? `Nothing new — ${skippedN} already in folder`
            : "No matching audio files in Downloads"
          : `Moved ${movedN} file${movedN === 1 ? "" : "s"}` +
            (skippedN ? ` · skipped ${skippedN}` : "");
      if (errorN > 0) {
        toast.warning(`${summary} · ${errorN} error${errorN === 1 ? "" : "s"}`);
      } else if (movedN === 0) {
        toast.message(summary);
      } else {
        toast.success(summary);
      }
      setOpen(false);
      onComplete?.();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Fetch from Downloads failed",
      );
    } finally {
      setBusy(false);
    }
  }, [folderPath, resolvedDays, selected, selectedCount, onComplete]);

  useCommand({
    id: "library.fetch-from-downloads",
    label: "Fetch audio files from Downloads",
    description: "Move recent audio files from ~/Downloads into this folder",
    icon: Download,
    group: "Library",
    keywords: ["fetch", "download", "import", "ingest"],
    when: !disabled,
    run: ({ close }) => {
      setOpen(true);
      close();
    },
  });

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={disabled}
        onClick={() => setOpen(true)}
        title={
          disabled
            ? "Select a folder first"
            : "Move recent audio files from ~/Downloads"
        }
        className={cn("text-muted-foreground h-7 gap-1.5 text-xs", className)}
        data-testid="fetch-from-downloads-trigger"
      >
        <Download className="size-3.5" />
        Fetch from Downloads
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Fetch from Downloads</DialogTitle>
            <DialogDescription>
              Move recent audio files from <code>~/Downloads</code> into{" "}
              <span className="text-foreground font-medium">
                {folderPath ?? "—"}
              </span>
              . Files already present are skipped.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 py-2">
            <Label className="text-muted-foreground text-xs">Time window</Label>
            <ToggleGroup
              type="single"
              value={preset}
              onValueChange={(v) => v && setPreset(v)}
              className="justify-start"
            >
              {PRESETS.map((d) => (
                <ToggleGroupItem key={d} value={d} className="h-8 px-3 text-xs">
                  {d}d
                </ToggleGroupItem>
              ))}
              <ToggleGroupItem value="custom" className="h-8 px-3 text-xs">
                Custom
              </ToggleGroupItem>
            </ToggleGroup>
            {preset === "custom" && (
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  min={1}
                  max={365}
                  value={customDays}
                  onChange={(e) => setCustomDays(e.target.value)}
                  placeholder="Days"
                  className="h-8 w-24 text-xs"
                  data-testid="fetch-custom-days"
                />
                <span className="text-muted-foreground text-xs">days</span>
              </div>
            )}

            <div
              className="border-border/50 mt-2 rounded-md border"
              data-testid="fetch-preview"
            >
              <div className="text-muted-foreground flex items-center justify-between px-3 py-2 text-xs">
                <span data-testid="fetch-preview-summary">
                  {previewLoading
                    ? "Scanning Downloads…"
                    : previewError
                      ? previewError
                      : candidates.length === 0
                        ? "No matching audio files in Downloads"
                        : `${selectedCount} of ${candidates.length} file${
                            candidates.length === 1 ? "" : "s"
                          } will be moved`}
                </span>
                {skipped.length > 0 && !previewLoading && !previewError && (
                  <span title={skipped.join("\n")}>
                    {skipped.length} already in folder
                  </span>
                )}
              </div>

              {candidates.length > 0 && (
                <ul
                  className="border-border/50 max-h-48 overflow-y-auto border-t"
                  data-testid="fetch-preview-list"
                >
                  {candidates.map((c) => {
                    const isExcluded = excluded.has(c.name);
                    return (
                      <li
                        key={c.name}
                        className={cn(
                          "flex items-center gap-2 px-3 py-1.5 text-xs",
                          isExcluded && "text-muted-foreground line-through",
                        )}
                        data-testid="fetch-preview-item"
                        data-excluded={isExcluded ? "true" : "false"}
                      >
                        <span className="flex-1 truncate" title={c.name}>
                          {c.name}
                        </span>
                        <button
                          type="button"
                          onClick={() =>
                            setExcluded((prev) => {
                              const next = new Set(prev);
                              if (next.has(c.name)) next.delete(c.name);
                              else next.add(c.name);
                              return next;
                            })
                          }
                          className="text-muted-foreground hover:text-foreground rounded p-0.5"
                          aria-label={
                            isExcluded
                              ? `Include ${c.name}`
                              : `Exclude ${c.name}`
                          }
                          data-testid={`fetch-preview-toggle-${c.name}`}
                        >
                          <X className="size-3.5" />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setOpen(false)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={handleFetch}
              disabled={busy || disabled || selectedCount === 0}
              data-testid="fetch-confirm"
            >
              {busy
                ? "Fetching…"
                : selectedCount > 0
                  ? `Fetch ${selectedCount}`
                  : "Fetch"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
