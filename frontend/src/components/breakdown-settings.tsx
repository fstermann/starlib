"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";

const INSTALL_COMMANDS = `uv venv ~/.starlib-demucs
uv pip install --python ~/.starlib-demucs demucs soundfile`;

/** Settings > Breakdown: where Demucs lives and where stems are cached. */
export function BreakdownSettings() {
  const [demucsPython, setDemucsPython] = useState("");
  const [cacheDir, setCacheDir] = useState("");
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    api.getAppSettings().then((settings) => {
      setDemucsPython(settings.demucs_python ?? "");
      setCacheDir(settings.breakdown_cache_dir ?? "");
      setLoaded(true);
    });
  }, []);

  const save = async () => {
    await api.updateAppSettings({
      demucs_python: demucsPython.trim(),
      breakdown_cache_dir: cacheDir.trim(),
    });
    toast.success("Breakdown settings saved");
  };

  if (!loaded) return null;

  return (
    <div className="flex flex-col gap-6" data-testid="breakdown-settings">
      <h2 className="text-base font-semibold">Breakdown</h2>

      <div className="flex flex-col gap-2">
        <Label htmlFor="demucs-python" className="text-sm">
          Demucs Python
        </Label>
        <p className="text-xs text-[var(--text-muted)]">
          Track Breakdown separates stems with Demucs, which needs PyTorch
          (about 720 MB with the htdemucs model) and is not bundled. Install it
          once, then point this at that environment&apos;s Python:
        </p>
        <pre className="rounded-md bg-[var(--surface-3)] px-2.5 py-1.5 font-mono text-xs text-[var(--text)]">
          {INSTALL_COMMANDS}
        </pre>
        <Input
          id="demucs-python"
          className="font-mono"
          placeholder="~/.starlib-demucs/bin/python"
          value={demucsPython}
          onChange={(e) => setDemucsPython(e.target.value)}
        />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="breakdown-cache" className="text-sm">
          Stems folder
        </Label>
        <p className="text-xs text-[var(--text-muted)]">
          Stems are lossless FLAC, roughly 110 MB per six-minute track. Leave
          empty to keep them in the app cache.
        </p>
        <Input
          id="breakdown-cache"
          className="font-mono"
          placeholder="App cache"
          value={cacheDir}
          onChange={(e) => setCacheDir(e.target.value)}
        />
      </div>

      <Button
        variant="ghost"
        size="sm"
        className="self-start"
        onClick={() => void save()}
      >
        Save
      </Button>
    </div>
  );
}
