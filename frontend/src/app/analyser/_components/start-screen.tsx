"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  formatTimecode,
  listRecentJobs,
  type JobSummary,
} from "@/lib/analyser";

interface StartScreenProps {
  onStart: (input: { url: string }) => Promise<void>;
  onOpen: (jobId: string) => void;
  initialUrl?: string;
  errorMessage?: string | null;
}

export function AnalyserStartScreen({
  onStart,
  onOpen,
  initialUrl = "",
  errorMessage = null,
}: StartScreenProps) {
  const [url, setUrl] = useState(initialUrl);
  const [busy, setBusy] = useState(false);
  const [recent, setRecent] = useState<JobSummary[]>([]);

  useEffect(() => {
    void listRecentJobs(8)
      .then((res) => setRecent(res.jobs))
      .catch(() => setRecent([]));
  }, []);

  const submit = async () => {
    if (!url.trim() || busy) return;
    setBusy(true);
    try {
      await onStart({ url: url.trim() });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-6" data-testid="analyser-start-screen">
      <section className="border-border bg-surface-2 flex flex-col gap-3 rounded-lg border p-6">
        <h1 className="text-text text-xl font-semibold">Set Analyser</h1>
        <p className="text-text-muted text-sm">
          Paste a SoundCloud URL — Starlib downloads the set, streams BPM
          windows, detects section boundaries, and identifies tracks via Shazam.
        </p>
        <div className="flex flex-col gap-2">
          <Label htmlFor="analyser-url">SoundCloud URL</Label>
          <div className="flex gap-2">
            <Input
              id="analyser-url"
              data-testid="analyser-url-input"
              autoComplete="off"
              placeholder="https://soundcloud.com/dj/example-set"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void submit();
              }}
            />
            <Button
              onClick={submit}
              disabled={!url.trim() || busy}
              data-testid="analyser-start-button"
            >
              {busy ? "Starting…" : "Analyse"}
            </Button>
          </div>
          {errorMessage && (
            <p className="text-destructive text-xs">{errorMessage}</p>
          )}
        </div>
      </section>
      {recent.length > 0 && (
        <section className="border-border bg-surface-2 rounded-lg border p-4">
          <h2 className="text-text mb-2 text-sm font-semibold">
            Recent analyses
          </h2>
          <ul className="divide-border divide-y" data-testid="recent-jobs">
            {recent.map((j) => (
              <li
                key={j.id}
                className="flex items-center justify-between gap-3 py-2"
              >
                <button
                  type="button"
                  className="text-text hover:text-brand text-left"
                  onClick={() => onOpen(j.id)}
                >
                  <div className="font-medium">{j.title ?? "(untitled)"}</div>
                  <div className="text-text-muted text-xs">
                    {j.artist ?? "—"} ·{" "}
                    {j.duration_s ? formatTimecode(j.duration_s) : "—"} ·{" "}
                    {j.status}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
