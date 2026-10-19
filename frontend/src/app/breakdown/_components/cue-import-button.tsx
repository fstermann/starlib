"use client";

import { FileUp } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { importCue } from "@/lib/breakdown";

interface CueImportButtonProps {
  jobId: string;
  /** Tracks the import would replace; the dialog warns when there are any. */
  trackCount: number;
  onImported: () => void;
}

/** Replace the tracklist with a CUE sheet's tracks, e.g. the one a DJ app writes next to a recording. */
export function CueImportButton({
  jobId,
  trackCount,
  onImported,
}: CueImportButtonProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [skipRepeats, setSkipRepeats] = useState(true);

  const upload = async (file: File) => {
    setBusy(true);
    try {
      const { imported, skipped, linked } = await importCue(
        jobId,
        file,
        skipRepeats,
      );
      toast(
        `Imported ${imported} track${imported === 1 ? "" : "s"}` +
          (skipped > 0
            ? `, skipped ${skipped} repeated entr${skipped === 1 ? "y" : "ies"}`
            : "") +
          (linked > 0 ? `, ${linked} linked to SoundCloud` : ""),
      );
      onImported();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const onPicked = (file: File | undefined) => {
    if (inputRef.current) inputRef.current.value = "";
    if (file) setPending(file);
  };

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept=".cue"
        className="hidden"
        data-testid="cue-import-input"
        onChange={(e) => onPicked(e.target.files?.[0])}
      />
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="text-text-muted hover:text-text gap-1.5"
        disabled={busy}
        onClick={() => inputRef.current?.click()}
        data-testid="cue-import-trigger"
      >
        <FileUp className="size-4" />
        Import CUE
      </Button>
      <AlertDialog
        open={pending != null}
        onOpenChange={(open) => !open && setPending(null)}
      >
        <AlertDialogContent data-testid="cue-import-confirm-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {trackCount > 0 ? "Replace the tracklist?" : "Import CUE sheet"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {trackCount > 0
                ? `The ${trackCount} track${trackCount === 1 ? "" : "s"} in the tracklist, with their edits and alignments, will be replaced by the tracks in "${pending?.name ?? ""}".`
                : `The tracks in "${pending?.name ?? ""}" become the tracklist.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex flex-col gap-1">
            <Label className="text-text flex items-center gap-2 text-sm font-normal">
              <Checkbox
                checked={skipRepeats}
                onCheckedChange={(v) => setSkipRepeats(v === true)}
                data-testid="cue-import-skip-repeats"
              />
              Skip repeated entries
            </Label>
            <p className="text-text-subtle pl-6 text-xs">
              rekordbox lists a track again when its deck is played or cued
              later. A skipped entry&apos;s time goes to the track before it.
            </p>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              data-testid="cue-import-confirm"
              onClick={() => {
                if (pending) void upload(pending);
                setPending(null);
              }}
            >
              {trackCount > 0 ? "Replace" : "Import"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
