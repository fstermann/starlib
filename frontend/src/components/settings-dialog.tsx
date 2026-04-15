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
  Bot,
  Zap,
  Square,
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
import { api, type OllamaModel } from "@/lib/api";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { checkForUpdate, type UpdateResult } from "@/lib/updater";
import { isTauri } from "@/lib/tauri";
import { useTheme } from "next-themes";
import { cn } from "@/lib/utils";
import { RulesetManager } from "@/components/rulesets/ruleset-manager";
import { FolderConfigManager } from "@/components/rulesets/folder-config-manager";
import { Clapperboard, FolderOpen, Workflow } from "lucide-react";

type SectionId = "general" | "appearance" | "meta-editor" | "folders" | "rulesets" | "ollama" | "updates";

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
      { id: "ollama", label: "Ollama", icon: Bot },
      { id: "updates", label: "Updates", icon: RefreshCw },
    ],
  },
];

const RECOMMENDED_MODELS: { name: string; tier: string; description: string }[] = [
  {
    name: "gemma4:e2b",
    tier: "Minimal",
    description: "~2 GB, fast on any laptop CPU. Good for basic casing and tag cleanups.",
  },
  {
    name: "gemma4:26b",
    tier: "Advanced",
    description: "~16 GB, higher-quality suggestions. Recommended on machines with >=32 GB RAM or a GPU.",
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

  // Ollama state
  const [ollamaAvailable, setOllamaAvailable] = useState<boolean | null>(null);
  const [ollamaInstalled, setOllamaInstalled] = useState<boolean | null>(null);
  const [ollamaModels, setOllamaModels] = useState<OllamaModel[]>([]);
  const [ollamaUrl, setOllamaUrl] = useState("http://localhost:11434");
  const [ollamaUrlDraft, setOllamaUrlDraft] = useState("http://localhost:11434");
  const [ollamaModel, setOllamaModel] = useState("");
  const [ollamaStartedByUs, setOllamaStartedByUs] = useState(false);
  const [ollamaChecking, setOllamaChecking] = useState(false);
  const [ollamaStopping, setOllamaStopping] = useState(false);
  const [ollamaSaving, setOllamaSaving] = useState(false);

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
      api.getOllamaSettings(),
      api.getOllamaStatus(),
    ]).then(([autoUpdate, outputFormat, rootPath, ollamaSettings, ollamaStatus]) => {
      setAutoUpdate(autoUpdate);
      setPreferredOutputFormat(outputFormat);
      setRootFolder(rootPath);
      setRootFolderDraft(rootPath);
      setOllamaUrl(ollamaSettings.url);
      setOllamaUrlDraft(ollamaSettings.url);
      setOllamaModel(ollamaSettings.model);
      setOllamaAvailable(ollamaStatus.available);
      setOllamaInstalled(ollamaStatus.installed);
      setOllamaStartedByUs(ollamaStatus.started_by_us);
      if (ollamaStatus.available && ollamaStatus.models.length > 0) {
        api.getOllamaModels().then(({ models }) => setOllamaModels(models));
      }
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

  async function handleOllamaTestConnection() {
    setOllamaChecking(true);
    try {
      // Uses POST /start which auto-starts Ollama if installed but not running
      const status = await api.startOllama();
      setOllamaAvailable(status.available);
      setOllamaInstalled(status.installed);
      setOllamaStartedByUs(status.started_by_us);
      if (status.available) {
        const { models } = await api.getOllamaModels();
        setOllamaModels(models);
      } else {
        setOllamaModels([]);
      }
    } catch {
      setOllamaAvailable(false);
      setOllamaModels([]);
    } finally {
      setOllamaChecking(false);
    }
  }

  const [pullingModel, setPullingModel] = useState<string | null>(null);
  const [pullError, setPullError] = useState<string | null>(null);

  async function handleOllamaPullModel(name: string) {
    setPullingModel(name);
    setPullError(null);
    try {
      await api.pullOllamaModel(name);
      const { models } = await api.getOllamaModels();
      setOllamaModels(models);
      // Auto-select the newly pulled model if none is selected yet.
      if (!ollamaModel) {
        await api.updateOllamaSettings({ model: name });
        setOllamaModel(name);
      }
    } catch (err) {
      setPullError(err instanceof Error ? err.message : "Failed to pull model");
    } finally {
      setPullingModel(null);
    }
  }

  async function handleOllamaStop() {
    setOllamaStopping(true);
    try {
      const status = await api.stopOllama();
      setOllamaAvailable(status.available);
      setOllamaStartedByUs(status.started_by_us);
      setOllamaModels([]);
    } finally {
      setOllamaStopping(false);
    }
  }

  async function handleOllamaSaveUrl() {
    if (ollamaUrlDraft === ollamaUrl) return;
    setOllamaSaving(true);
    try {
      const updated = await api.updateOllamaSettings({ url: ollamaUrlDraft });
      setOllamaUrl(updated.url);
      setOllamaUrlDraft(updated.url);
      // Re-check connection with new URL
      setOllamaAvailable(null);
      setOllamaModels([]);
    } finally {
      setOllamaSaving(false);
    }
  }

  async function handleOllamaModelChange(model: string) {
    setOllamaModel(model);
    await api.updateOllamaSettings({ model });
  }

  function formatModelSize(bytes: number): string {
    if (bytes === 0) return "";
    const gb = bytes / 1e9;
    if (gb >= 1) return `${gb.toFixed(1)} GB`;
    return `${(bytes / 1e6).toFixed(0)} MB`;
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

            {section === "ollama" && loaded && (
              <div className="flex flex-col gap-6">
                <h2 className="text-base font-semibold">Ollama</h2>
                <p className="text-sm text-muted-foreground">
                  Connect to a local Ollama instance for LLM-powered features.
                </p>

                {/* Connection status */}
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      "size-2.5 rounded-full shrink-0",
                      ollamaAvailable === null
                        ? "bg-muted-foreground/30"
                        : ollamaAvailable
                          ? "bg-green-500"
                          : ollamaInstalled
                            ? "bg-yellow-500"
                            : "bg-red-500"
                    )}
                  />
                  <span className="text-sm">
                    {ollamaAvailable === null
                      ? "Checking…"
                      : ollamaAvailable
                        ? "Connected"
                        : ollamaInstalled
                          ? "Installed but not running"
                          : "Not installed"}
                  </span>
                  {ollamaAvailable && (
                    <span className="text-xs text-muted-foreground/50">
                      {ollamaStartedByUs ? "managed by Starlib" : "external"}
                    </span>
                  )}
                  {ollamaAvailable && ollamaStartedByUs && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 px-1.5 text-muted-foreground hover:text-destructive"
                          onClick={handleOllamaStop}
                          disabled={ollamaStopping}
                        >
                          {ollamaStopping ? (
                            <Loader2 className="size-3 animate-spin" />
                          ) : (
                            <Square className="size-3" />
                          )}
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Stop Ollama</TooltipContent>
                    </Tooltip>
                  )}
                </div>

                {/* Installed but not running — offer to start */}
                {ollamaAvailable === false && ollamaInstalled && (
                  <div className="rounded-md border border-yellow-500/20 bg-yellow-500/5 p-3 flex flex-col gap-2">
                    <p className="text-sm">
                      Ollama is installed but not running. You can start it manually
                      with <code className="bg-muted px-1 py-0.5 rounded text-xs">ollama serve</code>,
                      or let Starlib start it for you.
                    </p>
                    <Button
                      size="sm"
                      variant="outline"
                      className="w-fit"
                      onClick={handleOllamaTestConnection}
                      disabled={ollamaChecking}
                    >
                      {ollamaChecking ? (
                        <>
                          <Loader2 data-icon="inline-start" className="animate-spin" />
                          Starting…
                        </>
                      ) : (
                        <>
                          <Zap data-icon="inline-start" className="size-3.5" />
                          Start Ollama
                        </>
                      )}
                    </Button>
                  </div>
                )}

                {/* Not installed — show install instructions */}
                {ollamaAvailable === false && ollamaInstalled === false && (
                  <div className="rounded-md border border-border/50 bg-muted/30 p-4 flex flex-col gap-3">
                    <p className="text-sm font-medium">Install Ollama</p>
                    <div className="flex flex-col gap-2 text-xs text-muted-foreground">
                      <p>
                        <span className="font-medium text-foreground/80">macOS:</span>{" "}
                        <code className="bg-muted px-1 py-0.5 rounded">brew install ollama</code>
                      </p>
                      <p>
                        <span className="font-medium text-foreground/80">Linux:</span>{" "}
                        <code className="bg-muted px-1 py-0.5 rounded">curl -fsSL https://ollama.com/install.sh | sh</code>
                      </p>
                      <p>
                        <span className="font-medium text-foreground/80">Windows:</span>{" "}
                        Download from <span className="font-mono">ollama.com/download</span>
                      </p>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      After installing, pull a model:
                    </p>
                    <code className="text-xs bg-muted px-2 py-1 rounded w-fit">
                      ollama pull gemma4:e2b
                    </code>
                    <p className="text-xs text-muted-foreground">
                      Then re-open this page to connect.
                    </p>
                  </div>
                )}

                {/* URL configuration */}
                <div className="flex flex-col gap-1.5">
                  <Label className="text-sm">Server URL</Label>
                  <div className="flex gap-2">
                    <Input
                      value={ollamaUrlDraft}
                      onChange={(e) => setOllamaUrlDraft(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") handleOllamaSaveUrl(); }}
                      placeholder="http://localhost:11434"
                      className="h-8 font-mono text-xs flex-1"
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-8 shrink-0"
                      disabled={ollamaSaving || ollamaUrlDraft === ollamaUrl}
                      onClick={handleOllamaSaveUrl}
                    >
                      {ollamaSaving ? <Loader2 className="size-3.5 animate-spin" /> : "Save"}
                    </Button>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-8 shrink-0 px-2"
                          onClick={handleOllamaTestConnection}
                          disabled={ollamaChecking}
                        >
                          {ollamaChecking ? (
                            <Loader2 className="size-3.5 animate-spin" />
                          ) : (
                            <Zap className="size-3.5" />
                          )}
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Test connection</TooltipContent>
                    </Tooltip>
                  </div>
                </div>

                {/* Recommended models */}
                {ollamaAvailable && (
                  <div className="flex flex-col gap-2">
                    <Label className="text-sm">Recommended models</Label>
                    <p className="text-xs text-muted-foreground">
                      One-click install. Pulling a model can take several minutes the first time.
                    </p>
                    {pullError && (
                      <div className="text-xs text-destructive bg-destructive/10 border border-destructive/20 rounded-md px-2 py-1">
                        {pullError}
                      </div>
                    )}
                    <div className="flex flex-col gap-2">
                      {RECOMMENDED_MODELS.map((rec) => {
                        const installed = ollamaModels.some((m) => m.name === rec.name);
                        const isPulling = pullingModel === rec.name;
                        return (
                          <div
                            key={rec.name}
                            className="flex items-center gap-3 rounded-md border border-border/50 bg-muted/20 px-3 py-2"
                          >
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2">
                                <code className="text-xs font-mono font-medium">{rec.name}</code>
                                <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                                  {rec.tier}
                                </span>
                                {installed && (
                                  <span className="text-[10px] uppercase tracking-wider text-green-500/90">
                                    installed
                                  </span>
                                )}
                              </div>
                              <p className="text-xs text-muted-foreground mt-0.5">{rec.description}</p>
                            </div>
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 shrink-0"
                              onClick={() => handleOllamaPullModel(rec.name)}
                              disabled={installed || isPulling || pullingModel !== null}
                            >
                              {isPulling ? (
                                <>
                                  <Loader2 className="size-3 animate-spin" />
                                  Pulling…
                                </>
                              ) : installed ? (
                                "Installed"
                              ) : (
                                "Install"
                              )}
                            </Button>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Model selection */}
                {ollamaModels.length > 0 && (
                  <div className="flex flex-col gap-1.5">
                    <Label className="text-sm">Model</Label>
                    <Select value={ollamaModel} onValueChange={handleOllamaModelChange}>
                      <SelectTrigger className="h-8 w-fit min-w-48 font-mono text-xs">
                        <SelectValue placeholder="Select a model" />
                      </SelectTrigger>
                      <SelectContent>
                        {ollamaModels.map((m) => (
                          <SelectItem key={m.name} value={m.name} className="font-mono text-xs">
                            {m.name}
                            {m.size > 0 && (
                              <span className="text-muted-foreground ml-2">
                                ({formatModelSize(m.size)})
                              </span>
                            )}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
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
