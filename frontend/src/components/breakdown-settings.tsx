"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";

import { StemSetup } from "@/components/stem-setup";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";

/** Settings > Breakdown: stem separation setup and where stems are cached. */
export function BreakdownSettings() {
  const [cacheDir, setCacheDir] = useState<string | null>(null);

  useEffect(() => {
    api
      .getAppSettings()
      .then((settings) => setCacheDir(settings.breakdown_cache_dir ?? ""));
  }, []);

  const save = async () => {
    await api.updateAppSettings({
      breakdown_cache_dir: (cacheDir ?? "").trim(),
    });
    toast.success("Stems folder saved");
  };

  return (
    <div className="flex flex-col gap-6" data-testid="breakdown-settings">
      <h2 className="text-base font-semibold">Breakdown</h2>

      <div className="flex flex-col gap-2">
        <Label className="text-sm">Stem separation</Label>
        <StemSetup />
      </div>

      {cacheDir !== null && (
        <div className="flex flex-col gap-2">
          <Label htmlFor="breakdown-cache" className="text-sm">
            Stems folder
          </Label>
          <p className="text-xs text-[var(--text-muted)]">
            Stems are lossless FLAC, roughly 110 MB per six-minute track. Leave
            empty to keep them in the app cache.
          </p>
          <div className="flex gap-2">
            <Input
              id="breakdown-cache"
              className="font-mono"
              placeholder="App cache"
              value={cacheDir}
              onChange={(e) => setCacheDir(e.target.value)}
            />
            <Button variant="ghost" size="sm" onClick={() => void save()}>
              Save
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
