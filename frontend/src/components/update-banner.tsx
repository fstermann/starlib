"use client";

import { useEffect, useState } from "react";
import { Download, X, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { checkForUpdate, type UpdateResult } from "@/lib/updater";
import { getSetting } from "@/lib/settings";
import { isTauri } from "@/lib/tauri";

export function UpdateBanner() {
  const [update, setUpdate] = useState<UpdateResult | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [installing, setInstalling] = useState(false);

  useEffect(() => {
    if (!isTauri()) return;

    let cancelled = false;
    (async () => {
      const auto = await getSetting("autoUpdate");
      if (!auto || cancelled) return;
      try {
        const result = await checkForUpdate();
        if (!cancelled && result.available) {
          setUpdate(result);
        }
      } catch (err) {
        console.error("[updater] check failed:", err);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (!update?.available || dismissed) return null;

  async function handleInstall() {
    if (!update?.install) return;
    setInstalling(true);
    try {
      await update.install();
    } catch (err) {
      console.error("[updater] install failed:", err);
      setInstalling(false);
    }
  }

  return (
    <div className="bg-primary/10 border-b border-primary/20 px-4 py-2 flex items-center gap-3 text-sm">
      <Download className="size-4 text-primary shrink-0" />
      <span className="flex-1 text-foreground">
        <span className="font-medium">Starlib {update.update?.version}</span> is available.
      </span>
      <Button
        size="sm"
        className="h-7 text-xs"
        onClick={handleInstall}
        disabled={installing}
      >
        {installing ? (
          <>
            <Loader2 className="size-3 animate-spin mr-1" />
            Installing…
          </>
        ) : (
          "Update now"
        )}
      </Button>
      <button
        onClick={() => setDismissed(true)}
        className="text-muted-foreground hover:text-foreground transition-colors"
        aria-label="Dismiss"
      >
        <X className="size-4" />
      </button>
    </div>
  );
}
