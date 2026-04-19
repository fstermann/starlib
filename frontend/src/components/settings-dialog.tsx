"use client";

import {
  Bot,
  CheckCircle2,
  Clapperboard,
  Download,
  FolderOpen,
  Loader2,
  Monitor,
  Moon,
  Paintbrush,
  RefreshCw,
  Settings as SettingsIcon,
  Square,
  Sun,
  Trash2,
  Workflow,
  XCircle,
  Zap,
} from "lucide-react";
import { useTheme } from "next-themes";
import React, { useEffect, useState } from "react";

import { FolderConfigManager } from "@/components/rulesets/folder-config-manager";
import { RulesetManager } from "@/components/rulesets/ruleset-manager";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  api,
  type AiModel,
  type AiProvider,
  type AiSettings,
  type FolderRulesetBinding,
  type Ruleset,
} from "@/lib/api";
import { getSetting, setSetting } from "@/lib/settings";
import { isTauri } from "@/lib/tauri";
import { checkForUpdate, type UpdateResult } from "@/lib/updater";
import { cn } from "@/lib/utils";

type SectionId =
  | "general"
  | "appearance"
  | "library"
  | "folders"
  | "rulesets"
  | "ai"
  | "updates";

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
    header: { id: "library", label: "Library", icon: Clapperboard },
    items: [
      { id: "folders", label: "Folders", icon: FolderOpen, indent: true },
      { id: "rulesets", label: "Rulesets", icon: Workflow, indent: true },
    ],
  },
  {
    label: "System",
    items: [
      { id: "ai", label: "AI", icon: Bot },
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
  const [preferredOutputFormat, setPreferredOutputFormat] = useState<
    "aiff" | "mp3"
  >("aiff");
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

  // AI state
  const [aiSettings, setAiSettings] = useState<AiSettings | null>(null);
  const [aiAvailable, setAiAvailable] = useState<boolean | null>(null);
  const [aiInstalled, setAiInstalled] = useState<boolean | null>(null);
  const [aiStartedByUs, setAiStartedByUs] = useState(false);
  const [aiModels, setAiModels] = useState<AiModel[]>([]);
  const [ollamaUrlDraft, setOllamaUrlDraft] = useState(
    "http://localhost:11434",
  );
  const [ollamaChecking, setOllamaChecking] = useState(false);
  const [ollamaStopping, setOllamaStopping] = useState(false);
  const [ollamaSaving, setOllamaSaving] = useState(false);
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [apiKeySaving, setApiKeySaving] = useState(false);
  const [apiKeyError, setApiKeyError] = useState<string | null>(null);

  // Per-folder rulesets
  const [folderRulesets, setFolderRulesets] = useState<
    Record<string, FolderRulesetBinding>
  >({});
  const [allRulesets, setAllRulesets] = useState<Ruleset[]>([]);

  useEffect(() => {
    setMounted(true);
  }, []);

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
      api.getAiSettings(),
      api.getAiStatus(),
      api.getAllFolderRulesets(),
      api.getRulesets(),
    ]).then(
      ([
        autoUpdate,
        outputFormat,
        rootPath,
        settings,
        status,
        folderRulesetsData,
        rulesetsData,
      ]) => {
        setAutoUpdate(autoUpdate);
        setPreferredOutputFormat(outputFormat);
        setRootFolder(rootPath);
        setRootFolderDraft(rootPath);
        setAiSettings(settings);
        setOllamaUrlDraft(settings.ollama.url);
        setAiAvailable(status.available);
        setAiInstalled(status.installed);
        setAiStartedByUs(status.started_by_us);
        if (status.available) {
          api.getAiModels().then(({ models }) => setAiModels(models));
        }
        setFolderRulesets(folderRulesetsData.folder_rulesets);
        setAllRulesets(rulesetsData.rulesets);
        setLoaded(true);
      },
    );
  }, [open]);

  async function handleAutoUpdateChange(checked: boolean) {
    setAutoUpdate(checked);
    await setSetting("autoUpdate", checked);
  }

  async function handlePreferredOutputFormatChange(format: "aiff" | "mp3") {
    setPreferredOutputFormat(format);
    await setSetting("preferredOutputFormat", format);
    await api.updateAppSettings({ preferred_output_format: format });
    window.dispatchEvent(
      new CustomEvent("preferred-format-changed", { detail: format }),
    );
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

  async function refreshAiStatus() {
    const status = await api.getAiStatus();
    setAiAvailable(status.available);
    setAiInstalled(status.installed);
    setAiStartedByUs(status.started_by_us);
    if (status.available) {
      const { models } = await api.getAiModels();
      setAiModels(models);
    } else {
      setAiModels([]);
    }
  }

  async function handleProviderChange(provider: AiProvider) {
    const next = await api.updateAiSettings({ provider });
    setAiSettings(next);
    await refreshAiStatus();
  }

  async function handleOllamaTestConnection() {
    setOllamaChecking(true);
    try {
      const status = await api.startOllama();
      setAiAvailable(status.available);
      setAiInstalled(status.installed);
      setAiStartedByUs(status.started_by_us);
      if (status.available) {
        const { models } = await api.getAiModels();
        setAiModels(models);
      } else {
        setAiModels([]);
      }
    } catch {
      setAiAvailable(false);
      setAiModels([]);
    } finally {
      setOllamaChecking(false);
    }
  }

  async function handleOllamaStop() {
    setOllamaStopping(true);
    try {
      const status = await api.stopOllama();
      setAiAvailable(status.available);
      setAiStartedByUs(status.started_by_us);
      setAiModels([]);
    } finally {
      setOllamaStopping(false);
    }
  }

  async function handleOllamaSaveUrl() {
    if (!aiSettings || ollamaUrlDraft === aiSettings.ollama.url) return;
    setOllamaSaving(true);
    try {
      const next = await api.updateAiSettings({
        ollama: { url: ollamaUrlDraft },
      });
      setAiSettings(next);
      setOllamaUrlDraft(next.ollama.url);
      setAiAvailable(null);
      setAiModels([]);
    } finally {
      setOllamaSaving(false);
    }
  }

  async function handleOllamaModelChange(model: string) {
    if (!aiSettings) return;
    const next = await api.updateAiSettings({ ollama: { model } });
    setAiSettings(next);
  }

  async function handleAnthropicModelChange(model: string) {
    if (!aiSettings) return;
    const next = await api.updateAiSettings({ anthropic: { model } });
    setAiSettings(next);
  }

  async function handleSaveApiKey() {
    if (!apiKeyDraft.trim()) return;
    setApiKeySaving(true);
    setApiKeyError(null);
    try {
      const next = await api.setAnthropicApiKey(apiKeyDraft.trim());
      setAiSettings(next);
      setApiKeyDraft("");
      await refreshAiStatus();
    } catch (err) {
      setApiKeyError(err instanceof Error ? err.message : "Failed to save key");
    } finally {
      setApiKeySaving(false);
    }
  }

  async function handleDeleteApiKey() {
    const next = await api.deleteAnthropicApiKey();
    setAiSettings(next);
    await refreshAiStatus();
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
      <DialogContent className="data-[state=open]:slide-in-from-top-[0%] data-[state=closed]:slide-out-to-top-[0%] top-[10vh] translate-y-0 gap-0 p-0 sm:max-w-4xl">
        <DialogTitle className="sr-only">Settings</DialogTitle>
        <div className="flex h-[min(700px,85vh)] overflow-hidden">
          {/* Left nav */}
          <nav className="border-border flex w-48 shrink-0 flex-col gap-4 border-r p-3">
            {NAV_GROUPS.map((group) => (
              <div key={group.label} className="flex flex-col gap-0.5">
                {!group.header && (
                  <p className="text-muted-foreground px-3 pb-1 text-xs font-semibold">
                    {group.label}
                  </p>
                )}
                {group.header && (
                  <button
                    onClick={() => setSection(group.header!.id)}
                    className={cn(
                      "flex cursor-pointer items-center gap-2 rounded-md px-3 py-1.5 text-left text-sm transition-colors",
                      section === group.header!.id
                        ? "bg-accent text-accent-foreground"
                        : "text-foreground hover:text-foreground hover:bg-accent",
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
                      "flex cursor-pointer items-center gap-2 rounded-md py-1.5 text-left text-sm transition-colors",
                      indent ? "pr-3 pl-8" : "px-3",
                      section === id
                        ? "bg-accent text-accent-foreground"
                        : "text-muted-foreground hover:text-foreground hover:bg-accent",
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
                <p className="text-muted-foreground text-sm">
                  General application settings will appear here.
                </p>
              </div>
            )}

            {section === "library" && (
              <div className="flex flex-col gap-6">
                <h2 className="text-base font-semibold">Library</h2>

                <div className="flex flex-col gap-2">
                  <Label className="text-sm">Preferred output format</Label>
                  <p className="text-muted-foreground text-xs">
                    Used as the default format when adding convert rules.
                  </p>
                  <ToggleGroup
                    type="single"
                    variant="outline"
                    value={preferredOutputFormat}
                    onValueChange={(val) => {
                      if (val)
                        handlePreferredOutputFormatChange(
                          val as "aiff" | "mp3",
                        );
                    }}
                    className="w-fit"
                  >
                    <ToggleGroupItem value="aiff" className="font-mono">
                      AIFF
                    </ToggleGroupItem>
                    <ToggleGroupItem value="mp3" className="font-mono">
                      MP3
                    </ToggleGroupItem>
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
                    onValueChange={(val) => {
                      if (val) setTheme(val);
                    }}
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
                    <p className="text-muted-foreground text-xs">
                      The root directory that contains all your music folders.
                    </p>
                    <div className="flex gap-2">
                      <Input
                        value={rootFolderDraft}
                        onChange={(e) => {
                          setRootFolderDraft(e.target.value);
                          setRootFolderError(null);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") handleSaveRootFolder();
                        }}
                        placeholder="~/Music"
                        className="h-8 flex-1 font-mono text-xs"
                      />
                      {inTauri && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-8 shrink-0 px-2"
                          title="Browse for folder"
                          onClick={async () => {
                            const { open } =
                              await import("@tauri-apps/plugin-dialog");
                            const selected = await open({
                              directory: true,
                              multiple: false,
                            });
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
                        disabled={
                          rootFolderSaving || rootFolderDraft === rootFolder
                        }
                        onClick={handleSaveRootFolder}
                      >
                        {rootFolderSaving ? (
                          <Loader2 className="size-3.5 animate-spin" />
                        ) : (
                          "Save"
                        )}
                      </Button>
                    </div>
                    {rootFolderError && (
                      <p className="text-destructive text-xs">
                        {rootFolderError}
                      </p>
                    )}
                  </div>
                </div>

                <div className="flex flex-col gap-4">
                  <h2 className="text-base font-semibold">Folder shortcuts</h2>
                  <p className="text-muted-foreground text-sm">
                    Choose which folders appear as quick-access buttons in the
                    meta editor, and in what order. Removing a shortcut only
                    hides it — it does not delete the folder or any tracks on
                    disk. Per-folder rulesets are configured below.
                  </p>
                  <FolderConfigManager />
                </div>

                <div className="flex flex-col gap-4">
                  <h2 className="text-base font-semibold">Folder rulesets</h2>
                  <p className="text-muted-foreground text-sm">
                    Assign rulesets to specific folders. Tracks finalized from a
                    folder with a bound ruleset will use that ruleset instead of
                    the global default. You can also assign rulesets via
                    right-click in the folder tree.
                  </p>

                  <FolderRulesetAdder
                    rootFolder={rootFolder}
                    allRulesets={allRulesets}
                    inTauri={inTauri}
                    onAdded={async () => {
                      const data = await api.getAllFolderRulesets();
                      setFolderRulesets(data.folder_rulesets);
                    }}
                  />

                  {Object.keys(folderRulesets).length === 0 ? (
                    <p className="text-muted-foreground text-xs italic">
                      No folder-specific rulesets configured. Add one above, or
                      right-click a folder in the tree.
                    </p>
                  ) : (
                    <div className="flex flex-col gap-1.5">
                      {Object.entries(folderRulesets).map(([path, binding]) => {
                        const ruleset = allRulesets.find(
                          (r) => r.id === binding.ruleset_id,
                        );
                        const displayPath =
                          rootFolder && path.startsWith(rootFolder)
                            ? path.slice(rootFolder.length + 1) || "/"
                            : path;
                        return (
                          <div
                            key={path}
                            className="bg-muted flex items-center gap-2 rounded-md px-2 py-1.5"
                          >
                            <FolderOpen className="text-muted-foreground size-3.5 shrink-0" />
                            <span
                              className="flex-1 truncate font-mono text-xs"
                              title={path}
                            >
                              {displayPath}
                            </span>
                            <span
                              className="text-muted-foreground flex shrink-0 items-center gap-1 text-xs"
                              title={
                                ruleset
                                  ? binding.recursive
                                    ? `Ruleset: ${ruleset.name} (applies to this folder and sub-folders)`
                                    : `Ruleset: ${ruleset.name}`
                                  : "Unknown ruleset"
                              }
                            >
                              <Workflow
                                className={`size-3 ${ruleset ? "text-primary" : "text-muted-foreground"}`}
                                {...(binding.recursive
                                  ? { strokeWidth: 2.5 }
                                  : {})}
                              />
                              {binding.recursive && (
                                <span className="text-primary text-xs leading-none font-semibold">
                                  R
                                </span>
                              )}
                              <span
                                className={
                                  ruleset ? "" : "text-muted-foreground italic"
                                }
                              >
                                {ruleset?.name ?? "Unknown"}
                              </span>
                            </span>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="text-muted-foreground hover:text-destructive h-6 w-6 shrink-0 p-0"
                              onClick={async () => {
                                await api.deleteFolderRuleset(path);
                                const data = await api.getAllFolderRulesets();
                                setFolderRulesets(data.folder_rulesets);
                              }}
                            >
                              <Trash2 className="size-3" />
                            </Button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            )}

            {section === "rulesets" && (
              <div className="flex flex-col gap-4">
                <h2 className="text-base font-semibold">Rulesets</h2>
                <p className="text-muted-foreground text-sm">
                  A ruleset is a sequence of steps that run automatically when
                  you finalize a track. Each step can convert, move, or copy the
                  file — and can reference the output of an earlier step.
                </p>
                <p className="text-muted-foreground text-xs">
                  Steps under <span className="font-medium">if converted</span>{" "}
                  only run when the conversion actually produced a new file —
                  useful for archiving the original.
                </p>
                <RulesetManager />
              </div>
            )}

            {section === "ai" && loaded && aiSettings && (
              <div className="flex flex-col gap-6">
                <h2 className="text-base font-semibold">AI</h2>
                <p className="text-muted-foreground text-sm">
                  Pick a provider for LLM-powered features. Use local Ollama for
                  offline inference, or Claude for higher quality via the
                  Anthropic API.
                </p>

                {/* Provider selector */}
                <div className="flex flex-col gap-1.5">
                  <Label className="text-sm">Provider</Label>
                  <ToggleGroup
                    type="single"
                    value={aiSettings.provider}
                    onValueChange={(v) =>
                      v && handleProviderChange(v as AiProvider)
                    }
                    className="w-fit"
                  >
                    <ToggleGroupItem value="ollama" className="gap-2 text-xs">
                      <img
                        src="/icons/ollama.svg"
                        alt=""
                        className="size-4 dark:invert"
                      />
                      Ollama
                    </ToggleGroupItem>
                    <ToggleGroupItem
                      value="claude_code"
                      className="gap-2 text-xs"
                    >
                      <img
                        src="/icons/claude-color.svg"
                        alt=""
                        className="size-4"
                      />
                      Claude Code
                    </ToggleGroupItem>
                    <ToggleGroupItem
                      value="anthropic"
                      className="gap-2 text-xs"
                    >
                      <img
                        src="/icons/anthropic.svg"
                        alt=""
                        className="size-4 dark:invert"
                      />
                      Anthropic API
                    </ToggleGroupItem>
                  </ToggleGroup>
                </div>

                {aiSettings.provider === "ollama" && (
                  <div className="border-border flex flex-col gap-6 border-t pt-6">
                    {/* Connection status */}
                    <div className="flex items-center gap-2">
                      <span
                        className={cn(
                          "size-2.5 shrink-0 rounded-full",
                          aiAvailable === null
                            ? "bg-muted-foreground/30"
                            : aiAvailable
                              ? "bg-success"
                              : aiInstalled
                                ? "bg-warning"
                                : "bg-destructive",
                        )}
                      />
                      <span className="text-sm">
                        {aiAvailable === null
                          ? "Checking…"
                          : aiAvailable
                            ? "Connected"
                            : aiInstalled
                              ? "Installed but not running"
                              : "Not installed"}
                      </span>
                      {aiAvailable && (
                        <span className="text-muted-foreground text-xs">
                          {aiStartedByUs ? "managed by Starlib" : "external"}
                        </span>
                      )}
                      {aiAvailable && aiStartedByUs && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="text-muted-foreground hover:text-destructive h-6 px-1.5"
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
                    {aiAvailable === false && aiInstalled && (
                      <div className="border-warning/20 bg-warning/5 flex flex-col gap-2 rounded-md border p-3">
                        <p className="text-sm">
                          Ollama is installed but not running. You can start it
                          manually with{" "}
                          <code className="bg-muted rounded px-1 py-0.5 text-xs">
                            ollama serve
                          </code>
                          , or let Starlib start it for you.
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
                              <Loader2
                                data-icon="inline-start"
                                className="animate-spin"
                              />
                              Starting…
                            </>
                          ) : (
                            <>
                              <Zap
                                data-icon="inline-start"
                                className="size-3.5"
                              />
                              Start Ollama
                            </>
                          )}
                        </Button>
                      </div>
                    )}

                    {/* Not installed — show install instructions */}
                    {aiAvailable === false && aiInstalled === false && (
                      <div className="border-border bg-muted flex flex-col gap-3 rounded-md border p-4">
                        <p className="text-sm font-medium">Install Ollama</p>
                        <div className="text-muted-foreground flex flex-col gap-2 text-xs">
                          <p>
                            <span className="text-foreground font-medium">
                              macOS:
                            </span>{" "}
                            <code className="bg-muted rounded px-1 py-0.5">
                              brew install ollama
                            </code>
                          </p>
                          <p>
                            <span className="text-foreground font-medium">
                              Linux:
                            </span>{" "}
                            <code className="bg-muted rounded px-1 py-0.5">
                              curl -fsSL https://ollama.com/install.sh | sh
                            </code>
                          </p>
                          <p>
                            <span className="text-foreground font-medium">
                              Windows:
                            </span>{" "}
                            Download from{" "}
                            <span className="font-mono">
                              ollama.com/download
                            </span>
                          </p>
                        </div>
                        <p className="text-muted-foreground text-xs">
                          After installing, pull a model:
                        </p>
                        <code className="bg-muted w-fit rounded px-2 py-1 text-xs">
                          ollama pull gemma4:e2b
                        </code>
                      </div>
                    )}

                    {/* URL configuration */}
                    <div className="flex flex-col gap-1.5">
                      <Label className="text-sm">Server URL</Label>
                      <div className="flex gap-2">
                        <Input
                          value={ollamaUrlDraft}
                          onChange={(e) => setOllamaUrlDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") handleOllamaSaveUrl();
                          }}
                          placeholder="http://localhost:11434"
                          className="h-8 flex-1 font-mono text-xs"
                        />
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-8 shrink-0"
                          disabled={
                            ollamaSaving ||
                            ollamaUrlDraft === aiSettings.ollama.url
                          }
                          onClick={handleOllamaSaveUrl}
                        >
                          {ollamaSaving ? (
                            <Loader2 className="size-3.5 animate-spin" />
                          ) : (
                            "Save"
                          )}
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

                    {/* Model selection */}
                    {aiModels.length > 0 && (
                      <div className="flex flex-col gap-1.5">
                        <Label className="text-sm">Model</Label>
                        <Select
                          value={aiSettings.ollama.model}
                          onValueChange={handleOllamaModelChange}
                        >
                          <SelectTrigger className="h-8 w-fit min-w-48 font-mono text-xs">
                            <SelectValue placeholder="Select a model" />
                          </SelectTrigger>
                          <SelectContent>
                            {aiModels.map((m) => (
                              <SelectItem
                                key={m.id}
                                value={m.id}
                                className="font-mono text-xs"
                              >
                                {m.id}
                                {m.size && m.size > 0 && (
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

                {aiSettings.provider === "claude_code" && (
                  <div className="border-border flex flex-col gap-6 border-t pt-6">
                    <div className="flex items-center gap-2">
                      <span
                        className={cn(
                          "size-2.5 shrink-0 rounded-full",
                          aiAvailable === null
                            ? "bg-muted-foreground/30"
                            : aiAvailable
                              ? "bg-success"
                              : "bg-destructive",
                        )}
                      />
                      <span className="text-sm">
                        {aiAvailable === null
                          ? "Checking…"
                          : aiAvailable
                            ? "Claude Code CLI detected"
                            : "Claude Code CLI not installed"}
                      </span>
                    </div>

                    {aiAvailable === false && (
                      <div className="border-border bg-muted flex flex-col gap-2 rounded-md border p-4">
                        <p className="text-sm font-medium">
                          Install Claude Code
                        </p>
                        <p className="text-muted-foreground text-xs">
                          Uses your existing Claude subscription login — no
                          separate API key required. Install at{" "}
                          <span className="font-mono">claude.com/code</span>.
                        </p>
                      </div>
                    )}

                    {aiAvailable && aiModels.length > 0 && (
                      <div className="flex flex-col gap-1.5">
                        <Label className="text-sm">Model</Label>
                        <Select
                          value={aiSettings.claude_code.model}
                          onValueChange={async (model) => {
                            const next = await api.updateAiSettings({
                              claude_code: { model },
                            });
                            setAiSettings(next);
                          }}
                        >
                          <SelectTrigger className="h-8 w-fit min-w-48 font-mono text-xs">
                            <SelectValue placeholder="Select a model" />
                          </SelectTrigger>
                          <SelectContent>
                            {aiModels.map((m) => (
                              <SelectItem
                                key={m.id}
                                value={m.id}
                                className="font-mono text-xs"
                              >
                                {m.display_name ?? m.id}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    )}
                  </div>
                )}

                {aiSettings.provider === "anthropic" && (
                  <div className="border-border flex flex-col gap-6 border-t pt-6">
                    {/* Key status */}
                    <div className="flex items-center gap-2">
                      <span
                        className={cn(
                          "size-2.5 shrink-0 rounded-full",
                          aiSettings.anthropic_has_api_key
                            ? aiAvailable
                              ? "bg-success"
                              : "bg-warning"
                            : "bg-destructive",
                        )}
                      />
                      <span className="text-sm">
                        {!aiSettings.anthropic_has_api_key
                          ? "No API key set"
                          : aiAvailable
                            ? "Connected"
                            : "Key set but unreachable"}
                      </span>
                    </div>

                    {/* API key form */}
                    <div className="flex flex-col gap-1.5">
                      <Label className="text-sm">Anthropic API key</Label>
                      <p className="text-muted-foreground text-xs">
                        Stored in your OS keychain — never written to disk in
                        plain text. Get one at{" "}
                        <span className="font-mono">console.anthropic.com</span>
                        .
                      </p>
                      <div className="flex gap-2">
                        <Input
                          type="password"
                          value={apiKeyDraft}
                          onChange={(e) => setApiKeyDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") handleSaveApiKey();
                          }}
                          placeholder={
                            aiSettings.anthropic_has_api_key
                              ? "••••••••"
                              : "sk-ant-…"
                          }
                          className="h-8 flex-1 font-mono text-xs"
                        />
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-8 shrink-0"
                          disabled={apiKeySaving || !apiKeyDraft.trim()}
                          onClick={handleSaveApiKey}
                        >
                          {apiKeySaving ? (
                            <Loader2 className="size-3.5 animate-spin" />
                          ) : (
                            "Save"
                          )}
                        </Button>
                        {aiSettings.anthropic_has_api_key && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-8 shrink-0"
                            onClick={handleDeleteApiKey}
                          >
                            Clear
                          </Button>
                        )}
                      </div>
                      {apiKeyError && (
                        <p className="text-destructive text-xs">
                          {apiKeyError}
                        </p>
                      )}
                    </div>

                    {/* Model selection */}
                    {aiSettings.anthropic_has_api_key &&
                      aiModels.length > 0 && (
                        <div className="flex flex-col gap-1.5">
                          <Label className="text-sm">Model</Label>
                          <Select
                            value={aiSettings.anthropic.model}
                            onValueChange={handleAnthropicModelChange}
                          >
                            <SelectTrigger className="h-8 w-fit min-w-64 font-mono text-xs">
                              <SelectValue placeholder="Select a model" />
                            </SelectTrigger>
                            <SelectContent>
                              {aiModels.map((m) => (
                                <SelectItem
                                  key={m.id}
                                  value={m.id}
                                  className="font-mono text-xs"
                                >
                                  {m.display_name ?? m.id}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      )}
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
                  <Label
                    htmlFor="auto-update"
                    className="cursor-pointer text-sm"
                  >
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
                          <Loader2
                            data-icon="inline-start"
                            className="animate-spin"
                          />
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
                      <p className="text-muted-foreground flex items-center gap-1.5 text-sm">
                        <CheckCircle2 className="text-success size-4" />
                        You&apos;re on the latest version.
                      </p>
                    )}

                    {updateResult?.available && updateResult.update && (
                      <div className="border-primary/20 bg-brand-soft flex flex-col gap-2 rounded-md border p-3">
                        <p className="text-sm font-medium">
                          Starlib {updateResult.update.version} is available
                        </p>
                        {updateResult.update.body && (
                          <p className="text-muted-foreground line-clamp-3 text-xs">
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
                              <Loader2
                                data-icon="inline-start"
                                className="animate-spin"
                              />
                              Installing…
                            </>
                          ) : (
                            "Update now"
                          )}
                        </Button>
                      </div>
                    )}

                    {checkError && (
                      <p className="text-destructive flex items-center gap-1.5 text-sm">
                        <XCircle className="size-4" />
                        {checkError}
                      </p>
                    )}
                  </div>
                )}

                {!inTauri && (
                  <p className="text-muted-foreground text-xs">
                    Update checking is only available in the desktop app.
                  </p>
                )}

                {version && (
                  <p className="text-muted-foreground mt-auto text-xs">
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

interface FolderRulesetAdderProps {
  rootFolder: string;
  allRulesets: Ruleset[];
  inTauri: boolean;
  onAdded: () => void | Promise<void>;
}

function FolderRulesetAdder({
  rootFolder,
  allRulesets,
  inTauri,
  onAdded,
}: FolderRulesetAdderProps) {
  const [pathDraft, setPathDraft] = useState("");
  const [rulesetId, setRulesetId] = useState<string>("");
  const [recursive, setRecursive] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = pathDraft.trim().length > 0 && rulesetId && !saving;

  async function handleAdd() {
    if (!canSubmit) return;
    setSaving(true);
    setError(null);
    try {
      await api.setFolderRuleset(pathDraft.trim(), rulesetId, recursive);
      setPathDraft("");
      setRulesetId("");
      setRecursive(false);
      await onAdded();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to add binding");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="border-border bg-muted flex flex-col gap-1.5 rounded-md border p-2.5">
      <Label className="text-xs font-medium">Add a folder ruleset</Label>
      <div className="flex gap-2">
        <Input
          value={pathDraft}
          onChange={(e) => {
            setPathDraft(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleAdd();
          }}
          placeholder={
            rootFolder ? `${rootFolder}/subfolder` : "/absolute/path/to/folder"
          }
          className="h-8 flex-1 font-mono text-xs"
        />
        {inTauri && (
          <Button
            size="sm"
            variant="outline"
            className="h-8 shrink-0 px-2"
            title="Browse for folder"
            onClick={async () => {
              const { open } = await import("@tauri-apps/plugin-dialog");
              const selected = await open({
                directory: true,
                multiple: false,
                defaultPath: rootFolder || undefined,
              });
              if (typeof selected === "string") {
                setPathDraft(selected);
                setError(null);
              }
            }}
          >
            <FolderOpen className="size-3.5" />
          </Button>
        )}
      </div>
      <div className="flex items-center gap-2">
        <Select value={rulesetId} onValueChange={setRulesetId}>
          <SelectTrigger className="h-8 flex-1 text-xs">
            <SelectValue placeholder="Select ruleset…" />
          </SelectTrigger>
          <SelectContent>
            {allRulesets.map((r) => (
              <SelectItem key={r.id} value={r.id} className="text-xs">
                {r.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <label className="text-muted-foreground flex shrink-0 cursor-pointer items-center gap-1.5 px-1 text-xs select-none">
          <Checkbox
            checked={recursive}
            onCheckedChange={(v) => setRecursive(v === true)}
          />
          Recursive
        </label>
        <Button
          size="sm"
          variant="outline"
          className="h-8 shrink-0"
          disabled={!canSubmit}
          onClick={handleAdd}
        >
          {saving ? <Loader2 className="size-3.5 animate-spin" /> : "Add"}
        </Button>
      </div>
      {error && <p className="text-destructive text-xs">{error}</p>}
    </div>
  );
}
