"use client";

import { useCallback, useEffect, useState } from "react";

import { Spinner } from "@/components/spinner";
import { Button } from "@/components/ui/button";
import {
  getStemSetup,
  installStemSetup,
  removeStemSetup,
  type StemSetup as SetupState,
} from "@/lib/track-breakdown";

const POLL_MS = 1000;
const STAGE_LABELS: Record<NonNullable<SetupState["stage"]>, string> = {
  uv: "Getting the installer",
  python: "Getting Python",
  packages: "Downloading PyTorch and Demucs (about 650 MB)",
  model: "Downloading the separation model (about 90 MB)",
  drum_model: "Downloading the drum model (about 170 MB)",
};

function megabytes(bytes: number): string {
  return `${Math.round(bytes / 2 ** 20)} MB`;
}

/**
 * Status and one-click setup for Demucs stem separation. Calls `onReady`
 * once an install started here finishes.
 */
export function StemSetup({ onReady }: { onReady?: () => void }) {
  const [setup, setSetup] = useState<SetupState | null>(null);

  const refresh = useCallback(() => getStemSetup().then(setSetup), []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (setup?.status !== "installing") return;
    const timer = window.setInterval(() => {
      void getStemSetup().then((next) => {
        setSetup(next);
        if (next.status === "ready") onReady?.();
      });
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [setup?.status, onReady]);

  if (!setup) return null;

  return (
    <div
      className="flex flex-col gap-2"
      data-testid="stem-setup"
      data-status={setup.status}
    >
      {setup.status === "ready" ? (
        <div className="flex items-center gap-3">
          <span className="text-sm text-[var(--text)]">
            Stem separation is ready
            <span className="text-[var(--text-muted)]">
              {" "}
              · {megabytes(setup.size_bytes)}
            </span>
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void removeStemSetup().then(setSetup)}
          >
            Remove
          </Button>
        </div>
      ) : setup.status === "installing" ? (
        <div className="flex items-center gap-2 text-sm text-[var(--text)]">
          <Spinner className="size-4" />
          <span data-testid="stem-setup-stage">
            {setup.stage ? STAGE_LABELS[setup.stage] : "Starting"}…
          </span>
        </div>
      ) : (
        <>
          <p className="text-sm text-[var(--text-muted)]">
            Splitting tracks into drums, bass, other and vocals, and the drums
            into kick, snare and hats, uses Demucs. Setting it up downloads
            about 1 GB once (Python, PyTorch and two models) into the app&apos;s
            folder; it takes about a minute.
          </p>
          {setup.status === "error" && (
            <p
              className="text-sm text-[var(--danger)]"
              data-testid="stem-setup-error"
            >
              {setup.error}
            </p>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="self-start text-[var(--brand)]"
            onClick={() => void installStemSetup().then(setSetup)}
            data-testid="stem-setup-install"
          >
            {setup.status === "error" ? "Try again" : "Set up stem separation"}
          </Button>
        </>
      )}
    </div>
  );
}
