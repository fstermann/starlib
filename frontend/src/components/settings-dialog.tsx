"use client";

import { useEffect, useState } from "react";
import {
  Download,
  Loader2,
  CheckCircle2,
  XCircle,
  Settings as SettingsIcon,
  Paintbrush,
  RefreshCw,
  Moon,
  Sun,
  Monitor,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { getSetting, setSetting } from "@/lib/settings";
import { checkForUpdate, type UpdateResult } from "@/lib/updater";
import { isTauri } from "@/lib/tauri";
import { useTheme } from "next-themes";
import { cn } from "@/lib/utils";

const SECTIONS = [
  { id: "general", label: "General", icon: SettingsIcon },
  { id: "appearance", label: "Appearance", icon: Paintbrush },
  { id: "updates", label: "Updates", icon: RefreshCw },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SettingsDialog({ open, onOpenChange }: SettingsDialogProps) {
  const [section, setSection] = useState<SectionId>("general");
  const [autoUpdate, setAutoUpdate] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [checking, setChecking] = useState(false);
  const [updateResult, setUpdateResult] = useState<UpdateResult | null>(null);
  const [installing, setInstalling] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => { setMounted(true); }, []);

  useEffect(() => {
    if (!open) return;
    getSetting("autoUpdate").then((val) => {
      setAutoUpdate(val);
      setLoaded(true);
    });
  }, [open]);

  async function handleAutoUpdateChange(checked: boolean) {
    setAutoUpdate(checked);
    await setSetting("autoUpdate", checked);
  }

  async function handleCheckForUpdates() {
    setChecking(true);
    setUpdateResult(null);
    setCheckError(null);
    try {
      const result = await checkForUpdate();
      setUpdateResult(result);
    } catch (err) {
      setCheckError(err instanceof Error ? err.message : "Update check failed");
    } finally {
      setChecking(false);
    }
  }

  async function handleInstall() {
    if (!updateResult?.install) return;
    setInstalling(true);
    try {
      await updateResult.install();
    } catch (err) {
      console.error("[updater] install failed:", err);
      setInstalling(false);
    }
  }

  const inTauri = isTauri();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl p-0 gap-0">
        <DialogTitle className="sr-only">Settings</DialogTitle>
        <div className="flex min-h-[400px]">
          {/* Left nav */}
          <nav className="w-44 shrink-0 border-r border-border/50 p-2 flex flex-col gap-0.5">
            {SECTIONS.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                onClick={() => setSection(id)}
                className={cn(
                  "flex items-center gap-2 px-3 py-2 rounded-md text-sm transition-colors text-left cursor-pointer",
                  section === id
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:text-foreground hover:bg-accent/50"
                )}
              >
                <Icon className="size-4 shrink-0" />
                {label}
              </button>
            ))}
          </nav>

          {/* Right content */}
          <div className="flex-1 p-6">
            {section === "general" && (
              <div className="flex flex-col gap-4">
                <h2 className="text-base font-semibold">General</h2>
                <p className="text-sm text-muted-foreground">
                  General application settings will appear here.
                </p>
              </div>
            )}

            {section === "appearance" && mounted && (
              <div className="flex flex-col gap-6">
                <h2 className="text-base font-semibold">Appearance</h2>

                <div className="flex flex-col gap-2">
                  <Label className="text-sm">Theme</Label>
                  <ToggleGroup
                    type="single"
                    variant="outline"
                    value={theme}
                    onValueChange={(val) => { if (val) setTheme(val); }}
                  >
                    <ToggleGroupItem value="light" aria-label="Light theme">
                      <Sun className="size-4" />
                      Light
                    </ToggleGroupItem>
                    <ToggleGroupItem value="dark" aria-label="Dark theme">
                      <Moon className="size-4" />
                      Dark
                    </ToggleGroupItem>
                    <ToggleGroupItem value="system" aria-label="System theme">
                      <Monitor className="size-4" />
                      System
                    </ToggleGroupItem>
                  </ToggleGroup>
                </div>
              </div>
            )}

            {section === "updates" && loaded && (
              <div className="flex flex-col gap-6">
                <h2 className="text-base font-semibold">Updates</h2>

                <div className="flex items-center gap-3">
                  <Checkbox
                    id="auto-update"
                    checked={autoUpdate}
                    onCheckedChange={(checked) =>
                      handleAutoUpdateChange(checked === true)
                    }
                  />
                  <Label htmlFor="auto-update" className="text-sm cursor-pointer">
                    Check for updates automatically on startup
                  </Label>
                </div>

                {inTauri && (
                  <div className="flex flex-col gap-3">
                    <Button
                      variant="outline"
                      size="sm"
                      className="w-fit"
                      onClick={handleCheckForUpdates}
                      disabled={checking}
                    >
                      {checking ? (
                        <>
                          <Loader2 data-icon="inline-start" className="animate-spin" />
                          Checking…
                        </>
                      ) : (
                        <>
                          <Download data-icon="inline-start" />
                          Check for updates
                        </>
                      )}
                    </Button>

                    {updateResult && !updateResult.available && (
                      <p className="text-sm text-muted-foreground flex items-center gap-1.5">
                        <CheckCircle2 className="size-4 text-green-500" />
                        You&apos;re on the latest version.
                      </p>
                    )}

                    {updateResult?.available && updateResult.update && (
                      <div className="rounded-md border border-primary/20 bg-primary/5 p-3 flex flex-col gap-2">
                        <p className="text-sm font-medium">
                          Starlib {updateResult.update.version} is available
                        </p>
                        {updateResult.update.body && (
                          <p className="text-xs text-muted-foreground line-clamp-3">
                            {updateResult.update.body}
                          </p>
                        )}
                        <Button
                          size="sm"
                          onClick={handleInstall}
                          disabled={installing}
                        >
                          {installing ? (
                            <>
                              <Loader2 data-icon="inline-start" className="animate-spin" />
                              Installing…
                            </>
                          ) : (
                            "Update now"
                          )}
                        </Button>
                      </div>
                    )}

                    {checkError && (
                      <p className="text-sm text-destructive flex items-center gap-1.5">
                        <XCircle className="size-4" />
                        {checkError}
                      </p>
                    )}
                  </div>
                )}

                {!inTauri && (
                  <p className="text-xs text-muted-foreground">
                    Update checking is only available in the desktop app.
                  </p>
                )}
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
