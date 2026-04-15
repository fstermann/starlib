'use client';

/**
 * Autoedit diff dialog.
 *
 * Shows the LLM-proposed metadata side-by-side with the user's current form
 * values. The user picks which fields to accept; only accepted fields are
 * applied via the onApply callback. The parent then commits through the
 * normal save flow.
 */

import { useEffect, useMemo, useState } from 'react';
import { Sparkles, Check, X, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { AutoeditResponse, TrackInfoUpdateRequest } from '@/lib/api';

const FIELD_LABELS: Record<string, string> = {
  title: 'Title',
  artist: 'Artist',
  genre: 'Genre',
  bpm: 'BPM',
  key: 'Key',
  original_artist: 'Original Artist',
  remixer: 'Remixer',
  mix_name: 'Mix Name',
  release_date: 'Release Date',
  release_year: 'Release Year',
  user_comment: 'Comment',
};

const ORDERED_FIELDS = Object.keys(FIELD_LABELS);

function formatValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (Array.isArray(value)) return value.join(', ');
  return String(value);
}

export interface AutoeditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  loading: boolean;
  error: string | null;
  result: AutoeditResponse | null;
  /** Stringified current form values (same shape the editor uses internally). */
  currentValues: Record<string, string>;
  /** Apply a subset of suggested fields; parent merges them into the form. */
  onApply: (accepted: Partial<TrackInfoUpdateRequest>) => void;
}

export function AutoeditDialog({
  open,
  onOpenChange,
  loading,
  error,
  result,
  currentValues,
  onApply,
}: AutoeditDialogProps) {
  const suggestions = result?.suggestions ?? {};

  const changedFields = useMemo(() => {
    return ORDERED_FIELDS.filter((key) => {
      const suggested = (suggestions as Record<string, unknown>)[key];
      if (suggested === undefined || suggested === null || suggested === '') return false;
      const current = currentValues[key] ?? '';
      return formatValue(suggested) !== formatValue(current);
    });
  }, [suggestions, currentValues]);

  const [selected, setSelected] = useState<Record<string, boolean>>({});

  // Default: select all changed fields when result arrives.
  useEffect(() => {
    if (!result) return;
    const next: Record<string, boolean> = {};
    changedFields.forEach((f) => {
      next[f] = true;
    });
    setSelected(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result]);

  const toggle = (key: string) => setSelected((prev) => ({ ...prev, [key]: !prev[key] }));
  const selectAll = () => setSelected(Object.fromEntries(changedFields.map((f) => [f, true])));
  const selectNone = () => setSelected({});

  const handleApply = () => {
    const accepted: Record<string, unknown> = {};
    changedFields.forEach((key) => {
      if (!selected[key]) return;
      accepted[key] = (suggestions as Record<string, unknown>)[key];
    });
    onApply(accepted as Partial<TrackInfoUpdateRequest>);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="size-4 text-amber-400" />
            Autoedit suggestions
          </DialogTitle>
          <DialogDescription>
            Review the LLM&rsquo;s proposed metadata changes. Accepted fields are applied to the
            editor; you still need to save to persist them.
          </DialogDescription>
        </DialogHeader>

        {loading && (
          <div className="flex items-center gap-2 py-8 justify-center text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Generating suggestions&hellip;
          </div>
        )}

        {error && !loading && (
          <div className="bg-destructive/10 border border-destructive/20 text-destructive text-xs px-3 py-2 rounded-lg">
            {error}
          </div>
        )}

        {!loading && !error && result && (
          <>
            {result.soundcloud_match && (
              <div className="flex items-center gap-3 border rounded-lg p-2 bg-muted/30">
                {result.soundcloud_match.artwork_url && (
                  <img
                    src={result.soundcloud_match.artwork_url}
                    alt=""
                    className="size-10 rounded object-cover"
                  />
                )}
                <div className="flex-1 min-w-0 text-xs">
                  <div className="text-muted-foreground">Reference match</div>
                  <a
                    href={result.soundcloud_match.permalink_url}
                    target="_blank"
                    rel="noreferrer"
                    className="font-medium truncate hover:underline block"
                  >
                    {result.soundcloud_match.title} &mdash; {result.soundcloud_match.artist}
                  </a>
                </div>
              </div>
            )}

            {changedFields.length === 0 ? (
              <div className="text-sm text-muted-foreground py-6 text-center">
                No changes proposed &mdash; the metadata already looks clean.
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">
                    {changedFields.length} suggested change{changedFields.length === 1 ? '' : 's'}
                  </span>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      className="text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
                      onClick={selectAll}
                    >
                      Select all
                    </button>
                    <button
                      type="button"
                      className="text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
                      onClick={selectNone}
                    >
                      None
                    </button>
                  </div>
                </div>

                <div className="flex flex-col divide-y divide-border/50 border rounded-lg max-h-[50vh] overflow-y-auto">
                  {changedFields.map((key) => {
                    const suggested = (suggestions as Record<string, unknown>)[key];
                    const current = currentValues[key] ?? '';
                    const isAccepted = !!selected[key];
                    return (
                      <label
                        key={key}
                        className="flex items-start gap-3 px-3 py-2 cursor-pointer hover:bg-accent/30"
                      >
                        <Checkbox
                          checked={isAccepted}
                          onCheckedChange={() => toggle(key)}
                          className="mt-0.5"
                        />
                        <div className="flex-1 min-w-0">
                          <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
                            {FIELD_LABELS[key]}
                          </div>
                          <div className="flex items-start gap-2 text-xs mt-0.5">
                            <span className="text-muted-foreground line-through truncate">
                              {formatValue(current)}
                            </span>
                            <span className="text-muted-foreground">&rarr;</span>
                            <span className="text-foreground font-medium truncate">
                              {formatValue(suggested)}
                            </span>
                          </div>
                        </div>
                      </label>
                    );
                  })}
                </div>
              </>
            )}
          </>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            <X className="size-3" />
            Cancel
          </Button>
          <Button
            onClick={handleApply}
            disabled={loading || !!error || changedFields.length === 0 || !Object.values(selected).some(Boolean)}
          >
            <Check className="size-3" />
            Apply selected
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
