"use client";

import { Download } from "lucide-react";
import { useCallback, useState } from "react";
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
import { api } from "@/lib/api";
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

  const disabled = !folderPath;

  const handleFetch = useCallback(async () => {
    if (!folderPath) return;
    const raw = preset === "custom" ? customDays : preset;
    const days = Number.parseInt(raw, 10);
    if (!Number.isFinite(days) || days < 1) {
      toast.error("Enter a positive number of days");
      return;
    }
    setBusy(true);
    try {
      const result = await api.fetchFromDownloads(folderPath, days);
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
  }, [folderPath, preset, customDays, onComplete]);

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
              disabled={busy || disabled}
              data-testid="fetch-confirm"
            >
              {busy ? "Fetching…" : "Fetch"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
