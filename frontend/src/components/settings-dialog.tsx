"use client";

import React, { useEffect, useState } from "react";
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
import { Input } from "@/components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { getSetting, setSetting } from "@/lib/settings";
import { api } from "@/lib/api";
import { checkForUpdate, type UpdateResult } from "@/lib/updater";
import { isTauri } from "@/lib/tauri";
import { useTheme } from "next-themes";
import { cn } from "@/lib/utils";
import { RulesetManager } from "@/components/rulesets/ruleset-manager";
import { FolderConfigManager } from "@/components/rulesets/folder-config-manager";
import { Clapperboard, FolderOpen, Workflow } from "lucide-react";

type SectionId = "general" | "appearance" | "meta-editor" | "folders" | "rulesets" | "updates";

interface NavItem {
  id: SectionId;
  label: string;
  icon: React.ElementType;
  indent?: boolean;
}

interface NavGroup {
  label: string;
  header?: NavItem;
  items: NavItem[];
}

const NAV_GROUPS: NavGroup[] = [
  {
    label: "General",
    items: [
      { id: "general", label: "General", icon: SettingsIcon },
      { id: "appearance", label: "Appearance", icon: Paintbrush },
    ],
  },
  {
    label: "Pages",
    header: { id: "meta-editor", label: "Meta Editor", icon: Clapperboard },
    items: [
      { id: "folders", label: "Folders", icon: FolderOpen, indent: true },
      { id: "rulesets", label: "Rulesets", icon: Workflow, indent: true },
    ],
  },
  {
    label: "System",
    items: [
      { id: "updates", label: "Updates", icon: RefreshCw },
    ],
  },
];

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SettingsDialog({ open, onOpenChange }: SettingsDialogProps) {
  const [section, setSection] = useState<SectionId>("general");
  const [autoUpdate, setAutoUpdate] = useState(true);
  const [preferredOutputFormat, setPreferredOutputFormat] = useState<"aiff" | "mp3">("aiff");
  const [loaded, setLoaded] = useState(false);
  const [checking, setChecking] = useState(false);
  const [updateResult, setUpdateResult] = useState<UpdateResult | null>(null);
  const [installing, setInstalling] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const [version, setVersion] = useState<string | null>(null);
  const [rootFolder, setRootFolder] = useState("");
  const [rootFolderDraft, setRootFolderDraft] = useState("");
  const [rootFolderSaving, setRootFolderSaving] = useState(false);
  const [rootFolderError, setRootFolderError] = useState<string | null>(null);

  useEffect(() => { setMounted(true); }, []);

  useEffect(() => {
    if (!isTauri()) {
      setVersion(process.env.NEXT_PUBLIC_APP_VERSION ?? null);
      return;
    }
    import("@tauri-apps/api/app")
      .then(({ getVersion }) => getVersion())
      .then(setVersion)
      .catch(() => setVersion(process.env.NEXT_PUBLIC_APP_VERSION ?? null));
  }, []);

  useEffect(() => {
    if (!open) return;
    Promise.all([
      getSetting("autoUpdate"),
      getSetting("preferredOutputFormat"),
      api.getRootMusicFolder(),
    ]).then(([autoUpdate, outputFormat, rootPath]) => {
      setAutoUpdate(autoUpdate);
      setPreferredOutputFormat(outputFormat);
      setRootFolder(rootPath);
      setRootFolderDraft(rootPath);
      setLoaded(true);
    });
  }, [open]);

  async function handleAutoUpdateChange(checked: boolean) {
    setAutoUpdate(checked);
    await setSetting("autoUpdate", checked);
  }

  async function handlePreferredOutputFormatChange(format: "aiff" | "mp3") {
    setPreferredOutputFormat(format);
    await setSetting("preferredOutputFormat", format);
    await api.updateAppSettings({ preferred_output_format: format });
    window.dispatchEvent(new CustomEvent("preferred-format-changed", { detail: format }));
  }

  async function handleSaveRootFolder() {
    if (rootFolderDraft === rootFolder) return;
    setRootFolderSaving(true);
    setRootFolderError(null);
    try {
      const saved = await api.updateRootMusicFolder(rootFolderDraft);
      setRootFolder(saved);
      setRootFolderDraft(saved);
    } catch (err) {
      setRootFolderError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setRootFolderSaving(false);
    }
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
      <DialogContent className="sm:max-w-4xl p-0 gap-0 translate-y-0 top-[10vh] data-[state=open]:slide-in-from-top-[0%] data-[state=closed]:slide-out-to-top-[0%]">
        <DialogTitle className="sr-only">Settings</DialogTitle>
        <div className="flex h-[min(700px,85vh)] overflow-hidden">
          {/* Left nav */}
          <nav className="w-48 shrink-0 border-r border-border/50 p-3 flex flex-col gap-4">
            {NAV_GROUPS.map((group) => (
              <div key={group.label} className="flex flex-col gap-0.5">
                {!group.header && (
                  <p className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/50">
                    {group.label}
                  </p>
                )}
                {group.header && (
                  <button
                    onClick={() => setSection(group.header!.id)}
                    className={cn(
                      "flex items-center gap-2 px-3 py-1.5 rounded-md text-sm transition-colors text-left cursor-pointer",
                      section === group.header!.id
                        ? "bg-accent text-accent-foreground"
                        : "text-foreground/70 hover:text-foreground hover:bg-accent/50"
                    )}
                  >
                    <group.header.icon className="size-4 shrink-0" />
                    {group.header.label}
                  </button>
                )}
                {group.items.map(({ id, label, icon: Icon, indent }) => (
                  <button
                    key={id}
                    onClick={() => setSection(id)}
                    className={cn(
                      "flex items-center gap-2 py-1.5 rounded-md text-sm transition-colors text-left cursor-pointer",
                      indent ? "pl-8 pr-3" : "px-3",
                      section === id
                        ? "bg-accent text-accent-foreground"
                        : "text-muted-foreground hover:text-foreground hover:bg-accent/50"
                    )}
                  >
                    <Icon className="size-4 shrink-0" />
                    {label}
                  </button>
                ))}
              </div>
            ))}
          </nav>

          {/* Right content */}
          <div className="flex-1 overflow-y-auto p-6 pt-5">
            {section === "general" && (
              <div className="flex flex-col gap-4">
                <h2 className="text-base font-semibold">General</h2>
                <p className="text-sm text-muted-foreground">
                  General application settings will appear here.
                </p>
              </div>
            )}

            {section === "meta-editor" && (
              <div className="flex flex-col gap-6">
                <h2 className="text-base font-semibold">Meta Editor</h2>

                <div className="flex flex-col gap-2">
                  <Label className="text-sm">Preferred output format</Label>
                  <p className="text-xs text-muted-foreground">
                    Used as the default format when adding convert rules.
                  </p>
                  <ToggleGroup
                    type="single"
                    variant="outline"
                    value={preferredOutputFormat}
                    onValueChange={(val) => { if (val) handlePreferredOutputFormatChange(val as "aiff" | "mp3"); }}
                    className="w-fit"
                  >
                    <ToggleGroupItem value="aiff" className="font-mono">AIFF</ToggleGroupItem>
                    <ToggleGroupItem value="mp3" className="font-mono">MP3</ToggleGroupItem>
                  </ToggleGroup>
                </div>
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

            {section === "folders" && (
              <div className="flex flex-col gap-6">
                <div className="flex flex-col gap-4">
                  <h2 className="text-base font-semibold">Folders</h2>

                  <div className="flex flex-col gap-1.5">
                    <Label className="text-sm">Music library root</Label>
                    <p className="text-xs text-muted-foreground">
                      The root directory that contains all your music folders.
                    </p>
                    <div className="flex gap-2">
                      <Input
                        value={rootFolderDraft}
                        onChange={(e) => { setRootFolderDraft(e.target.value); setRootFolderError(null); }}
                        onKeyDown={(e) => { if (e.key === "Enter") handleSaveRootFolder(); }}
                        placeholder="~/Music"
                        className="h-8 font-mono text-xs flex-1"
                      />
                      {inTauri && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-8 shrink-0 px-2"
                          title="Browse for folder"
                          onClick={async () => {
                            const { open } = await import("@tauri-apps/plugin-dialog");
                            const selected = await open({ directory: true, multiple: false });
                            if (typeof selected === "string") {
                              setRootFolderDraft(selected);
                              setRootFolderError(null);
                            }
                          }}
                        >
                          <FolderOpen className="size-3.5" />
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-8 shrink-0"
                        disabled={rootFolderSaving || rootFolderDraft === rootFolder}
                        onClick={handleSaveRootFolder}
                      >
                        {rootFolderSaving ? <Loader2 className="size-3.5 animate-spin" /> : "Save"}
                      </Button>
                    </div>
                    {rootFolderError && (
                      <p className="text-xs text-destructive">{rootFolderError}</p>
                    )}
                  </div>
                </div>

                <div className="flex flex-col gap-4">
                  <h2 className="text-base font-semibold">Folder tabs</h2>
                  <p className="text-sm text-muted-foreground">
                    Choose which folders appear in the meta editor, in what order,
                    and which ruleset applies when finalizing from each folder.
                    Removing a tab only hides it — it does not delete the folder or any tracks on disk.
                  </p>
                  <FolderConfigManager />
                </div>
              </div>
            )}

            {section === "rulesets" && (
              <div className="flex flex-col gap-4">
                <h2 className="text-base font-semibold">Rulesets</h2>
                <p className="text-sm text-muted-foreground">
                  A ruleset is a sequence of steps that run automatically when you finalize a track.
                  Each step can convert, move, or copy the file — and can reference the output of an earlier step.
                </p>
                <p className="text-xs text-muted-foreground/50">
                  Steps under <span className="font-medium">if converted</span> only run when the conversion actually produced a new file — useful for archiving the original.
                </p>
                <RulesetManager />
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

                {version && (
                  <p className="text-xs text-muted-foreground/60 mt-auto">
                    v{version}
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
