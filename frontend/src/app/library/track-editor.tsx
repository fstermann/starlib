"use client";

import { format, isValid, parse } from "date-fns";
import {
  CalendarIcon,
  Check,
  ChevronDown,
  Combine,
  Eraser,
  Image as ImageIcon,
  Link2,
  MoveRight,
  Parentheses,
  RotateCcw,
  Scissors,
  Search,
  Trash2,
  Type,
  Undo2,
  Waves,
  Workflow,
  X,
} from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { LogoSpinner } from "@/components/logo-spinner";
import { RULE_ICON_COLORS, RULE_ICONS } from "@/components/rulesets/rule-card";
import { RulesetPreview } from "@/components/rulesets/ruleset-preview";
import { Spinner } from "@/components/spinner";
import { AcceptAllSuggestionsButton } from "@/components/track-editor/accept-all-button";
import { FieldActionsMenu } from "@/components/track-editor/field-actions-menu";
import { SuggestionButton } from "@/components/track-editor/suggestion-button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  api,
  type FileInfo,
  type RequiredAttribute,
  type Ruleset,
  type RuleType,
  type TrackInfo,
  type TrackInfoUpdateRequest,
} from "@/lib/api";
import { applyRulesGate } from "@/lib/apply-rules-gate";
import { onRulesetsChanged } from "@/lib/rulesets-events";
import { soundCloudSource } from "@/lib/sources/soundcloud";
import {
  useTrackSuggestions,
  type SuggestionField,
} from "@/lib/sources/suggestions";
import type { SourceTrack } from "@/lib/sources/types";
import {
  cleanArtist,
  cleanTitle,
  parseFilename,
  removeMix,
  removeParenthesis,
  titelize,
} from "@/lib/string-utils";
import { analyzeLocalBpm, isTauri } from "@/lib/tauri";
import { cn } from "@/lib/utils";

import { useSourceSearch } from "./use-source-search";
import { parseComment, serializeComment } from "./utils";

export interface AutoActions {
  autoCopyArtwork: boolean;
  autoClean: boolean;
  autoTitelize: boolean;
  autoRemoveOriginalMix: boolean;
}

export interface TrackEditorProps {
  selectedFile: FileInfo;
  folderRulesetId: string | null;
  autoActions: AutoActions;
  onTableRefresh: () => void;
  onClose: () => void;
  /** Called after save to update the parent's selectedFile reference (may have new path). */
  onFileChange: (file: FileInfo) => void;
  /** Called after Apply Rules — selects the next track in the list. */
  onSelectNext: (currentFilePath: string) => void;
  /** Shared pending field edits — lifted to the page so this editor and the
   * batch table stay in sync while typing. */
  pendingFieldEdits: Map<string, Record<string, string>>;
  setPendingFieldEdits: React.Dispatch<
    React.SetStateAction<Map<string, Record<string, string>>>
  >;
}

export function TrackEditor({
  selectedFile,
  folderRulesetId,
  autoActions,
  onTableRefresh,
  onClose,
  onFileChange,
  onSelectNext,
  pendingFieldEdits,
  setPendingFieldEdits,
}: TrackEditorProps) {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";

  // Track loading
  const [trackInfo, setTrackInfo] = useState<TrackInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Source search panel
  const [scSidebarOpen, setScSidebarOpen] = useState(false);
  const activeSource = soundCloudSource;

  const sc = useSourceSearch(activeSource, true, setError);
  const {
    query: scQuery,
    setQuery: setScQuery,
    results: scResults,
    searching: scSearching,
    queryPending: scQueryPending,
    setQueryPending: setScQueryPending,
    selectedTrack: selectedScTrack,
    setSelectedTrack: setSelectedScTrack,
    handleSearch: handleScSearch,
    handleTrackSelect: handleScTrackSelect,
  } = sc;

  // Artwork state
  const [artworkUrl, setArtworkUrl] = useState<string | null>(null);
  const [pendingArtworkData, setPendingArtworkData] = useState<string | null>(
    null,
  );
  const [artworkPreviewOpen, setArtworkPreviewOpen] = useState(false);

  // Metadata form state — flat fields, no remix composite.
  const emptyFormData = {
    title: "",
    artist: "",
    bpm: "",
    key: "",
    genre: "",
    release_date: "",
    release_year: "",
    original_artist: "",
    remixer: "",
    mix_name: "",
    user_comment: "",
  };
  type FormFieldKey = keyof typeof emptyFormData;
  const [formData, setFormData] = useState({ ...emptyFormData });
  const [originalFormData, setOriginalFormData] = useState({
    ...emptyFormData,
  });
  // File path that the current formData / originalFormData correspond to.
  // Used to gate the mirror-to-pending effect so we don't race-write a stale
  // diff under a newly selected track's file_path during track switches.
  const [formDataFilePath, setFormDataFilePath] = useState<string | null>(null);

  // Track whether the user has manually edited release_year this session;
  // when false, editing release_date auto-syncs the year.
  const [releaseYearTouched, setReleaseYearTouched] = useState(false);

  // Structured comment state (SC ID + permalink)
  const [commentData, setCommentData] = useState({
    soundcloud_id: "",
    soundcloud_permalink: "",
  });
  const [scLinkEnabled, setScLinkEnabled] = useState(true);

  // BPM detection state (Rust-side analysis via Tauri invoke)
  const [bpmAnalyzing, setBpmAnalyzing] = useState(false);

  // Apply Rules is a long-running backend job (ffmpeg conversion + file moves).
  // Track it so we can disable the button + sibling actions and show a spinner
  // instead of letting users re-fire it. See #375.
  const [applying, setApplying] = useState(false);

  // Active ruleset (shown in Apply Rules popover) — only set when the folder has one assigned
  const [activeRuleset, setActiveRuleset] = useState<Ruleset | null>(null);
  useEffect(() => {
    if (!folderRulesetId) {
      setActiveRuleset(null);
      return;
    }
    let cancelled = false;
    function load() {
      api
        .getRulesets()
        .then((data) => {
          if (cancelled) return;
          setActiveRuleset(
            data.rulesets.find((r) => r.id === folderRulesetId) ?? null,
          );
        })
        .catch(() => {
          if (!cancelled) setActiveRuleset(null);
        });
    }
    load();
    const unsubscribe = onRulesetsChanged(load);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [folderRulesetId]);

  // Compute which of the ruleset's required attributes are missing on the current track
  const missingRequiredAttrs: RequiredAttribute[] = (() => {
    if (!activeRuleset?.required_attributes?.length || !trackInfo) return [];
    const isEmptyListOrString = (v: unknown) =>
      v == null ||
      (typeof v === "string" && !v.trim()) ||
      (Array.isArray(v) && v.length === 0);
    return activeRuleset.required_attributes.filter((attr) => {
      switch (attr) {
        case "title":
          return isEmptyListOrString(trackInfo.title);
        case "artist":
          return isEmptyListOrString(trackInfo.artist);
        case "genre":
          return isEmptyListOrString(trackInfo.genre);
        case "bpm":
          return !trackInfo.bpm;
        case "key":
          return isEmptyListOrString(trackInfo.key);
        case "release_date":
          return isEmptyListOrString(trackInfo.release_date);
        case "remixer":
          return isEmptyListOrString(trackInfo.remixer);
        case "comment":
          return isEmptyListOrString(trackInfo.user_comment);
        case "artwork":
          return !trackInfo.has_artwork;
      }
    });
  })();
  const hasMissingRequired = missingRequiredAttrs.length > 0;

  // Original values for SC-link change detection
  const [originalScLinkEnabled, setOriginalScLinkEnabled] = useState(true);
  const [originalCommentData, setOriginalCommentData] = useState({
    soundcloud_id: "",
    soundcloud_permalink: "",
  });

  // Confirm dialog
  const [confirmDialog, setConfirmDialog] = useState<{
    open: boolean;
    message: string;
    onConfirm: () => void;
  }>({
    open: false,
    message: "",
    onConfirm: () => {},
  });
  const showConfirm = (message: string, onConfirm: () => void) =>
    setConfirmDialog({ open: true, message, onConfirm });

  // Load track info when selectedFile changes
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const info = await api.getTrackInfo(selectedFile.file_path);
        if (!cancelled) setTrackInfo(info);
      } catch (err) {
        if (!cancelled)
          setError(
            err instanceof Error ? err.message : "Failed to load track info",
          );
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedFile.file_path]);

  // Selecting an SC track only sets the link + clears the pending flag.
  // Field values are never written without the user clicking a suggestion
  // (see ``useTrackSuggestions`` and ``SuggestionButton`` below) — copying
  // verbatim is still available via the per-field "copy from SC" buttons.
  useLayoutEffect(() => {
    setScQueryPending(false);
    if (!selectedScTrack) return;
    const meta = activeSource.extractMetadata(selectedScTrack);
    setCommentData((prev) => {
      // If prev already points at this exact SC track, preserve it so any
      // permalink formatting saved on the file is kept verbatim. Otherwise
      // adopt the newly selected track — `prev || meta` would otherwise pin
      // the link to the first match and silently ignore later selections.
      if (prev.soundcloud_id && prev.soundcloud_id === meta.source_id) {
        return prev;
      }
      return {
        soundcloud_id: meta.source_id,
        soundcloud_permalink: meta.source_permalink,
      };
    });
    setScLinkEnabled(true);
  }, [selectedScTrack, activeSource, setScQueryPending]);

  // Show source artwork in preview when no existing artwork
  useEffect(() => {
    if (
      !selectedScTrack ||
      !autoActions.autoCopyArtwork ||
      !trackInfo ||
      trackInfo.has_artwork
    )
      return;

    const hqUrl = activeSource.extractMetadata(selectedScTrack).artwork_url;
    if (!hqUrl) return;

    setArtworkUrl(hqUrl);
    api
      .proxyImage(hqUrl)
      .then((blob) => {
        const reader = new FileReader();
        reader.onloadend = () => {
          const b64 = (reader.result as string).split(",")[1];
          setPendingArtworkData(b64);
        };
        reader.readAsDataURL(blob);
      })
      .catch(() => {
        /* non-fatal */
      });
  }, [selectedScTrack, autoActions.autoCopyArtwork, trackInfo, activeSource]);

  // Update form when track info loads
  useEffect(() => {
    if (!trackInfo) return;

    const parsed = parseFilename(trackInfo.file_name);
    const joinList = (v: string | string[] | null | undefined): string =>
      Array.isArray(v) ? v.join(", ") : (v ?? "");
    // originalData reflects what's actually persisted in the file tags —
    // NO filename-parse fallback. This is the baseline isChanged() compares
    // against, so parse-derived values surface as dirty (yellow).
    const originalData: typeof emptyFormData = {
      title: trackInfo.title || "",
      artist: joinList(trackInfo.artist),
      bpm: trackInfo.bpm?.toString() || "",
      key: trackInfo.key || "",
      genre: trackInfo.genre || "",
      release_date: trackInfo.release_date || "",
      release_year: trackInfo.release_year?.toString() || "",
      original_artist: joinList(trackInfo.original_artist),
      remixer: joinList(trackInfo.remixer),
      mix_name: trackInfo.mix_name || "",
      user_comment: trackInfo.user_comment || "",
    };
    // Displayed form starts from real tags, falls back to filename parse for
    // empty title/artist, then auto-actions transform the values. Each step
    // only diverges from originalData when it produces a value the file
    // doesn't already have — so the yellow "changed" border tracks reality.
    const autoFilled: typeof emptyFormData = { ...originalData };
    if (!autoFilled.title && parsed.title) autoFilled.title = parsed.title;
    if (!autoFilled.artist && parsed.artist) autoFilled.artist = parsed.artist;
    if (autoActions.autoRemoveOriginalMix && autoFilled.title) {
      autoFilled.title = removeMix(autoFilled.title);
    }
    if (autoActions.autoClean) {
      if (autoFilled.title) autoFilled.title = cleanTitle(autoFilled.title);
      if (autoFilled.artist) autoFilled.artist = cleanArtist(autoFilled.artist);
    }
    if (autoActions.autoTitelize && autoFilled.title) {
      autoFilled.title = titelize(autoFilled.title);
    }
    // Overlay any pending edits the user made in the batch table before
    // opening the editor, so both surfaces show the same values.
    const existingPending = pendingFieldEdits.get(trackInfo.file_path) ?? {};
    const newFormData: typeof emptyFormData = {
      ...autoFilled,
      ...existingPending,
    } as typeof emptyFormData;
    setFormData(newFormData);
    setOriginalFormData(originalData);
    setFormDataFilePath(trackInfo.file_path);
    setReleaseYearTouched(false);
    const parsedComment = parseComment(trackInfo.starlib_meta);
    setCommentData(parsedComment);
    setScLinkEnabled(
      !!(parsedComment.soundcloud_id || parsedComment.soundcloud_permalink),
    );

    const initialScLinkEnabled = !!(
      parsedComment.soundcloud_id || parsedComment.soundcloud_permalink
    );
    setOriginalScLinkEnabled(initialScLinkEnabled);
    setOriginalCommentData(parsedComment);

    if (trackInfo.has_artwork) {
      setPendingArtworkData(null);
      setArtworkUrl(api.getArtworkUrl(trackInfo.file_path));
    } else {
      setArtworkUrl(null);
    }

    if (parsedComment.soundcloud_permalink) {
      setScQuery(parsedComment.soundcloud_permalink);
      setScQueryPending(true);
    } else if (trackInfo.file_name) {
      const cleaned = removeMix(
        trackInfo.file_name
          .replace(/\.(mp3|aiff|wav)$/i, "")
          .replace(/_/g, " ")
          .replace(/\[.*?\]/g, "")
          .trim(),
      );
      setScQuery(cleaned);
      setScQueryPending(true);
    }
    // Intentionally only runs when trackInfo changes — this initializes the
    // form from trackInfo + a snapshot of pendingFieldEdits. Re-running on
    // every pending edit would overwrite the user's in-progress input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackInfo]);

  const reloadTrackInfo = async (file: FileInfo) => {
    setLoading(true);
    setError(null);
    try {
      const info = await api.getTrackInfo(file.file_path);
      setTrackInfo(info);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to load track info",
      );
    } finally {
      setLoading(false);
    }
  };

  const handleArtworkUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    if (!event.target.files || event.target.files.length === 0) return;
    const file = event.target.files[0];
    setArtworkUrl(URL.createObjectURL(file));
    const reader = new FileReader();
    reader.onloadend = () => {
      const b64 = (reader.result as string).split(",")[1];
      setPendingArtworkData(b64);
    };
    reader.readAsDataURL(file);
  };

  const handleRemoveArtwork = () => {
    if (!trackInfo) return;

    if (pendingArtworkData) {
      setArtworkUrl(null);
      setPendingArtworkData(null);
      return;
    }

    showConfirm("Remove artwork from this file?", async () => {
      try {
        setLoading(true);
        await api.removeArtwork(trackInfo.file_path);
        setArtworkUrl(null);
        await reloadTrackInfo(selectedFile);
        toast.success("Artwork removed successfully");
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Failed to remove artwork",
        );
      } finally {
        setLoading(false);
      }
    });
  };

  const handleCleanTitle = () => {
    if (!formData.title) return;
    const transformed = cleanTitle(formData.title);
    if (transformed !== formData.title)
      setFormData({ ...formData, title: transformed });
  };

  const handleCleanArtist = () => {
    if (!formData.artist) return;
    const transformed = cleanArtist(formData.artist);
    if (transformed !== formData.artist)
      setFormData({ ...formData, artist: transformed });
  };

  const handleRemoveParenthesis = () => {
    if (!formData.title) return;
    const transformed = removeParenthesis(formData.title);
    if (transformed !== formData.title)
      setFormData({ ...formData, title: transformed });
  };

  const handleCopyFromSc = (field: keyof typeof formData) => {
    if (!selectedScTrack) return;
    const meta = activeSource.extractMetadata(selectedScTrack);
    const fieldMap: Record<string, string | undefined> = {
      title: meta.title,
      artist: meta.artist,
      genre: meta.genre,
      release_date: meta.release_date,
    };
    if (field in fieldMap) {
      setFormData({ ...formData, [field]: fieldMap[field] || "" });
    }
  };

  const handleBuildTitleFromRemix = () => {
    if (!formData.original_artist || !formData.remixer) return;
    const rawTitle = formData.title.replace(/\(.*?\)/g, "").trim();
    const mix = formData.mix_name || "Remix";
    const newTitle = `${formData.original_artist} - ${rawTitle} (${formData.remixer} ${mix})`;
    setFormData({ ...formData, title: newTitle });
  };

  const canBuildTitleFromRemix =
    !!formData.original_artist && !!formData.remixer;

  const handleIsolateTitle = () => {
    if (!formData.title) return;
    const match = formData.title.match(/.*?\s*-\s*([^(]*)/);
    if (match) {
      setFormData({ ...formData, title: match[1].trim() });
    }
  };

  // ``displayedFormData`` is the same as ``formData`` outside of preview mode,
  // so this stays right both during normal editing and while hovering the
  // bulk-accept button.
  const isChanged = (field: FormFieldKey) =>
    displayedFormData[field] !== originalFormData[field];

  const scBusy =
    (scSearching || scQueryPending) &&
    !commentData.soundcloud_id &&
    !commentData.soundcloud_permalink;
  // Toggling the SoundCloud chip only counts as an edit when it changes the
  // serialized starlib_meta that handleSave actually writes. Enabling the chip
  // on a track with no linked SC id writes nothing new, so it must not trip the
  // unsaved-changes gate — which would otherwise block Apply rules (see #371).
  const scMetaChanged =
    serializeComment(
      scLinkEnabled ? commentData.soundcloud_id : "",
      scLinkEnabled ? commentData.soundcloud_permalink : "",
    ) !==
    serializeComment(
      originalScLinkEnabled ? originalCommentData.soundcloud_id : "",
      originalScLinkEnabled ? originalCommentData.soundcloud_permalink : "",
    );
  const hasChanges =
    scBusy ||
    pendingArtworkData !== null ||
    (Object.keys(formData) as FormFieldKey[]).some(
      (k) => formData[k] !== originalFormData[k],
    ) ||
    scMetaChanged;

  // Show a hint when release_year and the year part of release_date disagree.
  const releaseDateYear =
    formData.release_date &&
    isValid(parse(formData.release_date, "yyyy-MM-dd", new Date()))
      ? parse(formData.release_date, "yyyy-MM-dd", new Date())
          .getFullYear()
          .toString()
      : "";
  const yearMismatch =
    !!formData.release_date &&
    !!formData.release_year &&
    releaseDateYear !== formData.release_year;

  const handleFormChange = (field: FormFieldKey, value: string) => {
    setFormData((prev) => {
      const next = { ...prev, [field]: value };
      // Auto-sync release_year from release_date when the user hasn't manually
      // overridden the year (issue #285: year ← date on edit, both stay editable).
      if (field === "release_date" && !releaseYearTouched) {
        const parsed =
          value && isValid(parse(value, "yyyy-MM-dd", new Date()))
            ? parse(value, "yyyy-MM-dd", new Date())
            : null;
        next.release_year = parsed ? parsed.getFullYear().toString() : "";
      }
      return next;
    });
    if (field === "release_year") setReleaseYearTouched(true);
  };

  // Snapshot of the editor state we send to the suggestion engine. Wrapped in
  // useMemo with a primitive-stable dependency list so we don't trigger a
  // new fetch on every render — the hook itself debounces between fetches.
  const suggestionsCurrent = useMemo(
    () => ({
      title: formData.title || null,
      artist: formData.artist || null,
      genre: formData.genre || null,
      bpm: formData.bpm ? parseInt(formData.bpm, 10) || null : null,
      key: formData.key || null,
      original_artist: formData.original_artist || null,
      remixer: formData.remixer || null,
      mix_name: formData.mix_name || null,
      release_date: formData.release_date || null,
      release_year: formData.release_year
        ? parseInt(formData.release_year, 10) || null
        : null,
      user_comment: formData.user_comment || null,
    }),
    [formData],
  );

  const handleAcceptSuggestion = (field: SuggestionField, value: unknown) => {
    if (field === "artwork_url") {
      // Artwork lands in pendingArtworkData (base64) via the existing proxy
      // pipeline so save-time semantics are unchanged.
      if (typeof value !== "string" || !value) return;
      setArtworkUrl(value);
      api
        .proxyImage(value)
        .then((blob) => {
          const reader = new FileReader();
          reader.onloadend = () => {
            const b64 = (reader.result as string).split(",")[1];
            setPendingArtworkData(b64);
          };
          reader.readAsDataURL(blob);
        })
        .catch(() => {
          toast.error("Failed to fetch artwork");
        });
      return;
    }
    // Numeric fields go in as strings to match the existing form-state shape.
    handleFormChange(field as FormFieldKey, value == null ? "" : String(value));
  };

  const {
    suggestions: trackSuggestions,
    accept: acceptSuggestion,
    acceptAll: acceptAllSuggestions,
    pendingCount: suggestionsPendingCount,
  } = useTrackSuggestions({
    filePath: trackInfo?.file_path ?? null,
    scTrack: (selectedScTrack?.raw as never) ?? null,
    current: suggestionsCurrent,
    onAccept: handleAcceptSuggestion,
    enabled: !!trackInfo,
  });

  // Hover-preview state: while the user hovers Accept All, the form inputs
  // *display* the suggested values without actually touching ``formData``.
  // Leaving the button instantly restores the live state.
  const [previewActive, setPreviewActive] = useState(false);

  const previewMap = useMemo<Record<string, string> | null>(() => {
    if (!previewActive) return null;
    const out: Record<string, string> = {};
    for (const field of Object.keys(trackSuggestions)) {
      if (!(field in emptyFormData)) continue; // artwork_url etc. handled separately
      const top = trackSuggestions[field]?.[0];
      if (!top) continue;
      out[field] = top.value == null ? "" : String(top.value);
    }
    return out;
    // emptyFormData is a literal shape, safe to omit from deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewActive, trackSuggestions]);

  const displayedFormData = previewMap
    ? ({ ...formData, ...previewMap } as typeof formData)
    : formData;

  const displayedArtworkUrl = (() => {
    if (!previewActive) return artworkUrl;
    const top = trackSuggestions.artwork_url?.[0];
    return typeof top?.value === "string" ? top.value : artworkUrl;
  })();

  // Mirror every formData diff vs originalFormData into the shared
  // pendingFieldEdits map so the batch table reflects editor changes —
  // including auto-actions (Clean, Titelize, Copy-from-SC, etc.) that bypass
  // handleFormChange by calling setFormData directly.
  useEffect(() => {
    if (!trackInfo) return;
    // Skip while formData/originalFormData still belong to the previously
    // selected track — otherwise a track switch would copy the old track's
    // diff under the new track's file_path.
    if (formDataFilePath !== trackInfo.file_path) return;
    const filePath = trackInfo.file_path;
    setPendingFieldEdits((prev) => {
      const entry: Record<string, string> = {};
      for (const key of Object.keys(formData) as FormFieldKey[]) {
        if (formData[key] !== (originalFormData[key] ?? "")) {
          entry[key] = formData[key];
        }
      }
      const existing = prev.get(filePath);
      const entryKeys = Object.keys(entry);
      if (entryKeys.length === 0) {
        if (!prev.has(filePath)) return prev;
        const next = new Map(prev);
        next.delete(filePath);
        return next;
      }
      const same =
        existing !== undefined &&
        Object.keys(existing).length === entryKeys.length &&
        entryKeys.every((k) => existing[k] === entry[k]);
      if (same) return prev;
      const next = new Map(prev);
      next.set(filePath, entry);
      return next;
    });
  }, [
    formData,
    originalFormData,
    trackInfo,
    formDataFilePath,
    setPendingFieldEdits,
  ]);

  // React to external edits to the same file (e.g. user changed a cell in
  // the batch table while the editor was open).
  useEffect(() => {
    if (!trackInfo) return;
    const external = pendingFieldEdits.get(trackInfo.file_path) ?? {};
    setFormData((prev) => {
      const merged: typeof emptyFormData = { ...originalFormData };
      for (const [k, v] of Object.entries(external)) {
        if (k in merged) (merged as Record<string, string>)[k] = v;
      }
      // Preserve any keys the user hasn't touched externally but has changed
      // locally (e.g. a field edit in flight).
      for (const key of Object.keys(prev) as FormFieldKey[]) {
        if (!(key in external) && prev[key] !== originalFormData[key])
          merged[key] = prev[key];
      }
      // Only return a new object when something actually changed to avoid
      // render loops.
      const changed = (Object.keys(merged) as FormFieldKey[]).some(
        (k) => merged[k] !== prev[k],
      );
      return changed ? merged : prev;
    });
  }, [pendingFieldEdits, trackInfo, originalFormData]);

  const handleSave = async () => {
    if (!trackInfo) return;

    try {
      setLoading(true);
      setError(null);

      // Always send every flat field — empty strings become `null` to clear
      // tags rather than carry stale data (the backend treats `None` as
      // delete).
      const updates: Record<string, string | number | string[] | null> = {};
      (Object.keys(formData) as FormFieldKey[]).forEach((key) => {
        const value = formData[key];
        if (key === "bpm" || key === "release_year") {
          updates[key] = value ? parseInt(value, 10) : null;
        } else {
          updates[key] = value === "" ? null : value;
        }
      });

      const starlibStr = serializeComment(
        scLinkEnabled ? commentData.soundcloud_id : "",
        scLinkEnabled ? commentData.soundcloud_permalink : "",
      );
      updates.starlib_meta = starlibStr || null;

      if (pendingArtworkData) {
        updates.artwork_data = pendingArtworkData;
      }

      const result = await api.updateTrackInfo(
        trackInfo.file_path,
        updates as TrackInfoUpdateRequest,
      );
      const newFilePath = result.new_file_path ?? trackInfo.file_path;
      const newFileInfo: FileInfo = {
        ...selectedFile,
        file_path: newFilePath,
        file_name: newFilePath.split("/").pop() ?? selectedFile.file_name,
      };
      // Persisted — drop the shared pending entry for both old and new paths.
      setPendingFieldEdits((prev) => {
        if (!prev.has(trackInfo.file_path) && !prev.has(newFilePath))
          return prev;
        const next = new Map(prev);
        next.delete(trackInfo.file_path);
        next.delete(newFilePath);
        return next;
      });
      onTableRefresh();
      onFileChange(newFileInfo);
      await reloadTrackInfo(newFileInfo);
      toast.success("Metadata saved successfully");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save metadata");
    } finally {
      setLoading(false);
    }
  };

  const handleApplyRules = () => {
    if (!trackInfo || applying) return;
    const filePath = trackInfo.file_path;
    const trackName = formData.title || selectedFile.file_name || filePath;
    const toastId = toast.loading(`Applying rules to "${trackName}"…`);
    setApplying(true);
    api
      .applyRules(filePath)
      .then((result) => {
        const steps = result.steps ?? [];
        toast.success(
          <div className="flex flex-col gap-1">
            <span className="text-sm font-medium">{trackName}</span>
            {steps.length > 0 && (
              <div className="mt-0.5 flex flex-col gap-0.5">
                {steps.map((step, i) => {
                  const Icon = RULE_ICONS[step.type as RuleType] ?? MoveRight;
                  const color =
                    RULE_ICON_COLORS[step.type as RuleType] ??
                    "text-muted-foreground";
                  return (
                    <div
                      key={i}
                      className="text-muted-foreground flex items-center gap-1.5 text-xs"
                    >
                      <Icon
                        className={`size-3 shrink-0 ${step.status === "skipped" ? "opacity-30" : color}`}
                      />
                      <span
                        className={
                          step.status === "skipped"
                            ? "line-through opacity-50"
                            : ""
                        }
                      >
                        {step.message}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>,
          { id: toastId },
        );
        onSelectNext(filePath);
        onTableRefresh();
      })
      .catch((err) => {
        const message =
          err instanceof Error ? err.message : "Failed to apply rules";
        toast.error(message, { id: toastId, duration: Infinity });
      })
      .finally(() => setApplying(false));
  };

  const handleDelete = () => {
    if (!trackInfo) return;
    showConfirm("Are you sure you want to delete this file?", async () => {
      try {
        setLoading(true);
        setError(null);
        await api.deleteFile(trackInfo.file_path);
        onTableRefresh();
        onClose();
        toast.success("File deleted successfully");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to delete file");
      } finally {
        setLoading(false);
      }
    });
  };

  const handleApplyScMetadata = (track: SourceTrack) => {
    const meta = activeSource.extractMetadata(track);

    setFormData((prev) => ({
      ...prev,
      ...(meta.title ? { title: meta.title } : {}),
      ...(meta.artist ? { artist: meta.artist } : {}),
      ...(meta.genre ? { genre: meta.genre } : {}),
      ...(meta.release_date ? { release_date: meta.release_date } : {}),
    }));

    setCommentData({
      soundcloud_id: meta.source_id,
      soundcloud_permalink: meta.source_permalink,
    });

    if (trackInfo && !trackInfo.has_artwork && meta.artwork_url) {
      setArtworkUrl(meta.artwork_url);
      api
        .proxyImage(meta.artwork_url)
        .then((blob) => {
          const reader = new FileReader();
          reader.onloadend = () => {
            const b64 = (reader.result as string).split(",")[1];
            setPendingArtworkData(b64);
          };
          reader.readAsDataURL(blob);
        })
        .catch(() => {
          /* non-fatal */
        });
    }
  };

  return (
    <div className="flex h-full flex-col">
      {/* Artwork lightbox preview */}
      {artworkPreviewOpen && artworkUrl && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
          onClick={() => setArtworkPreviewOpen(false)}
        >
          <img
            src={artworkUrl}
            alt="Artwork preview"
            className="max-h-[90vh] max-w-[min(500px,90vw)] rounded-xl object-contain shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}

      <AlertDialog
        open={confirmDialog.open}
        onOpenChange={(open) => setConfirmDialog((prev) => ({ ...prev, open }))}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmDialog.message}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                confirmDialog.onConfirm();
                setConfirmDialog((prev) => ({ ...prev, open: false }));
              }}
            >
              Confirm
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Panel header: filename + accept-all + close */}
      <div className="border-border flex h-10 shrink-0 items-center justify-between gap-2 border-b px-3">
        <span className="text-muted-foreground mr-2 min-w-0 truncate text-xs">
          {trackInfo?.file_name ?? selectedFile.file_name}
        </span>
        <div className="flex shrink-0 items-center gap-1.5">
          {trackInfo && suggestionsPendingCount > 0 && (
            <AcceptAllSuggestionsButton
              pendingCount={suggestionsPendingCount}
              onAcceptAll={acceptAllSuggestions}
              onPreviewStart={() => setPreviewActive(true)}
              onPreviewEnd={() => setPreviewActive(false)}
            />
          )}
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground hover:bg-accent flex size-5 cursor-pointer items-center justify-center rounded-md transition-colors"
            title="Close editor"
          >
            <X className="size-3" />
          </button>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="bg-destructive/10 border-destructive/20 text-destructive mx-3 mt-2 shrink-0 rounded-lg border px-3 py-2 text-xs">
          {error}
        </div>
      )}

      {/* Skeleton while loading */}
      {loading && !trackInfo && (
        <div className="flex flex-col gap-3 px-3 pt-3">
          <div className="flex items-start gap-3">
            <Skeleton className="size-21.5 shrink-0 rounded-lg" />
            <div className="flex flex-1 flex-col gap-1.5 pt-5">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Skeleton className="h-8" />
            <Skeleton className="h-8" />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Skeleton className="h-8" />
            <Skeleton className="h-8" />
          </div>
        </div>
      )}

      {/* Scrollable form */}
      {trackInfo && (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 py-3">
            {/* Artwork + Title + Artist */}
            <div className="flex items-start gap-3">
              {/* Artwork */}
              <div className="group flex shrink-0 flex-col items-center gap-0.5">
                <div className="flex h-4 items-center justify-between">
                  <div className="flex scale-75 gap-0.5 opacity-0 transition-all duration-150 ease-out group-hover:scale-100 group-hover:opacity-100">
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      title="Copy artwork from SoundCloud"
                      disabled={!selectedScTrack?.artwork_url}
                      onClick={() => {
                        if (!selectedScTrack) return;
                        const hqUrl =
                          activeSource.extractMetadata(
                            selectedScTrack,
                          ).artwork_url;
                        if (!hqUrl) return;
                        setArtworkUrl(hqUrl);
                        api
                          .proxyImage(hqUrl)
                          .then((blob) => {
                            const reader = new FileReader();
                            reader.onloadend = () => {
                              const b64 = (reader.result as string).split(
                                ",",
                              )[1];
                              setPendingArtworkData(b64);
                            };
                            reader.readAsDataURL(blob);
                          })
                          .catch(() => {});
                      }}
                    >
                      <activeSource.Icon className="size-3" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      title="Change artwork"
                      onClick={() => {
                        const input = document.createElement("input");
                        input.type = "file";
                        input.accept = "image/*";
                        input.onchange = handleArtworkUpload as unknown as (
                          this: GlobalEventHandlers,
                          ev: Event,
                        ) => unknown;
                        input.click();
                      }}
                    >
                      <ImageIcon />
                    </Button>
                    {artworkUrl && (
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        title="Remove artwork"
                        className="hover:text-destructive"
                        onClick={handleRemoveArtwork}
                      >
                        <Trash2 />
                      </Button>
                    )}
                  </div>
                </div>
                <div
                  className={`relative size-21.5 overflow-hidden rounded-lg border ${pendingArtworkData || (previewActive && displayedArtworkUrl !== artworkUrl) ? "border-warning/70" : "border-border"} ${artworkUrl ? "cursor-zoom-in" : "cursor-pointer"}`}
                  onClick={() => {
                    if (artworkUrl) {
                      setArtworkPreviewOpen(true);
                    } else {
                      const input = document.createElement("input");
                      input.type = "file";
                      input.accept = "image/*";
                      input.onchange = handleArtworkUpload as unknown as (
                        this: GlobalEventHandlers,
                        ev: Event,
                      ) => unknown;
                      input.click();
                    }
                  }}
                >
                  {displayedArtworkUrl ? (
                    <img
                      src={displayedArtworkUrl}
                      alt="Artwork"
                      className="size-full object-cover"
                    />
                  ) : (
                    <div className="bg-accent hover:bg-accent flex size-full flex-col items-center justify-center gap-0.5 transition-colors">
                      <ImageIcon className="text-muted-foreground size-3" />
                      <span className="text-muted-foreground text-xs">N/A</span>
                    </div>
                  )}
                </div>
              </div>

              {/* Title + Artist stacked */}
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                {/* Title */}
                <div className="group flex flex-col gap-0.5">
                  <div className="flex h-4 items-center justify-between">
                    <span className="text-2xs text-muted-foreground font-medium tracking-wider uppercase">
                      Title
                    </span>
                    <div className="flex gap-0.5 opacity-0 transition-opacity duration-150 ease-out group-focus-within:opacity-100 group-hover:opacity-100">
                      <SuggestionButton
                        field="title"
                        suggestions={trackSuggestions.title}
                        currentValue={formData.title}
                        onAccept={(s) => acceptSuggestion("title", s)}
                      />
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => handleCopyFromSc("title")}
                        disabled={!selectedScTrack}
                        title="Copy from SoundCloud"
                      >
                        <activeSource.Icon className="size-3.5" />
                      </Button>
                      <FieldActionsMenu
                        field="title"
                        actions={[
                          {
                            id: "title-clean",
                            label: "Clean",
                            icon: Eraser,
                            onSelect: handleCleanTitle,
                          },
                          {
                            id: "title-titelize",
                            label: "Titelize",
                            icon: Type,
                            onSelect: () => {
                              if (!formData.title) return;
                              const t = titelize(formData.title);
                              if (t !== formData.title)
                                setFormData({ ...formData, title: t });
                            },
                          },
                          {
                            id: "title-remove-brackets",
                            label: "Remove brackets",
                            icon: Parentheses,
                            onSelect: handleRemoveParenthesis,
                          },
                          {
                            id: "title-isolate",
                            label: "Isolate",
                            icon: Scissors,
                            onSelect: handleIsolateTitle,
                          },
                          {
                            id: "title-build-from-remix",
                            label: "Build from remix",
                            icon: Combine,
                            onSelect: handleBuildTitleFromRemix,
                            disabled: !canBuildTitleFromRemix,
                          },
                        ]}
                      />
                      {isChanged("title") && (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={() =>
                            handleFormChange("title", originalFormData.title)
                          }
                          title="Reset"
                        >
                          <Undo2 />
                        </Button>
                      )}
                    </div>
                  </div>
                  <Input
                    value={displayedFormData.title}
                    onChange={(e) => handleFormChange("title", e.target.value)}
                    className={`h-8 text-xs ${isChanged("title") ? "border-warning/70" : ""}`}
                    placeholder="Title"
                  />
                </div>

                {/* Artist */}
                <div className="group flex flex-col gap-0.5">
                  <div className="flex h-4 items-center justify-between">
                    <span className="text-2xs text-muted-foreground font-medium tracking-wider uppercase">
                      Artist
                    </span>
                    <div className="flex gap-0.5 opacity-0 transition-opacity duration-150 ease-out group-focus-within:opacity-100 group-hover:opacity-100">
                      <SuggestionButton
                        field="artist"
                        suggestions={trackSuggestions.artist}
                        currentValue={formData.artist}
                        onAccept={(s) => acceptSuggestion("artist", s)}
                      />
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => handleCopyFromSc("artist")}
                        disabled={!selectedScTrack}
                        title="Copy from SoundCloud"
                      >
                        <activeSource.Icon className="size-3.5" />
                      </Button>
                      <FieldActionsMenu
                        field="artist"
                        actions={[
                          {
                            id: "artist-clean",
                            label: "Clean",
                            icon: Eraser,
                            onSelect: handleCleanArtist,
                          },
                          {
                            id: "artist-titelize",
                            label: "Titelize",
                            icon: Type,
                            onSelect: () => {
                              if (!formData.artist) return;
                              const t = titelize(formData.artist);
                              if (t !== formData.artist)
                                setFormData({ ...formData, artist: t });
                            },
                          },
                        ]}
                      />
                      {isChanged("artist") && (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={() =>
                            handleFormChange("artist", originalFormData.artist)
                          }
                          title="Reset"
                        >
                          <Undo2 />
                        </Button>
                      )}
                    </div>
                  </div>
                  <Input
                    value={displayedFormData.artist}
                    onChange={(e) => handleFormChange("artist", e.target.value)}
                    className={`h-8 text-xs ${isChanged("artist") ? "border-warning/70" : ""}`}
                    placeholder="Artist"
                  />
                </div>
              </div>
            </div>

            {/* 2-col: Genre | BPM */}
            <div className="grid grid-cols-2 gap-2">
              {/* Genre */}
              <div className="group flex flex-col gap-0.5">
                <div className="flex h-4 items-center justify-between">
                  <span className="text-2xs text-muted-foreground font-medium tracking-wider uppercase">
                    Genre
                  </span>
                  <div className="flex gap-0.5 opacity-0 transition-opacity duration-150 ease-out group-focus-within:opacity-100 group-hover:opacity-100">
                    <SuggestionButton
                      field="genre"
                      suggestions={trackSuggestions.genre}
                      currentValue={formData.genre}
                      onAccept={(s) => acceptSuggestion("genre", s)}
                    />
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => handleCopyFromSc("genre")}
                      disabled={!selectedScTrack}
                      title="Copy from SoundCloud"
                    >
                      <activeSource.Icon className="size-3.5" />
                    </Button>
                    <FieldActionsMenu
                      field="genre"
                      actions={[
                        {
                          id: "genre-titelize",
                          label: "Titelize",
                          icon: Type,
                          onSelect: () => {
                            if (!formData.genre) return;
                            const t = titelize(formData.genre);
                            if (t !== formData.genre)
                              setFormData({ ...formData, genre: t });
                          },
                        },
                      ]}
                    />
                    {isChanged("genre") && (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() =>
                          handleFormChange("genre", originalFormData.genre)
                        }
                        title="Reset"
                      >
                        <Undo2 />
                      </Button>
                    )}
                  </div>
                </div>
                <Input
                  value={displayedFormData.genre}
                  onChange={(e) => handleFormChange("genre", e.target.value)}
                  className={`h-8 text-xs ${isChanged("genre") ? "border-warning/70" : ""}`}
                  placeholder="—"
                />
              </div>

              {/* BPM */}
              <div className="group flex flex-col gap-0.5">
                <div className="flex h-4 items-center justify-between">
                  <span className="text-2xs text-muted-foreground font-medium tracking-wider uppercase">
                    BPM
                  </span>
                  <div className="flex gap-0.5 opacity-0 transition-opacity duration-150 ease-out group-focus-within:opacity-100 group-hover:opacity-100">
                    <SuggestionButton
                      field="bpm"
                      suggestions={trackSuggestions.bpm}
                      currentValue={formData.bpm}
                      onAccept={(s) => acceptSuggestion("bpm", s)}
                    />
                    {isTauri() && trackInfo && (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={async () => {
                          setBpmAnalyzing(true);
                          try {
                            const result = await analyzeLocalBpm(
                              trackInfo.file_path,
                            );
                            handleFormChange(
                              "bpm",
                              String(Math.round(result.bpm)),
                            );
                            toast.success(
                              `Detected ${Math.round(result.bpm)} BPM (${result.confidence} confidence)`,
                            );
                          } catch (err) {
                            toast.error(
                              `BPM detection failed: ${err instanceof Error ? err.message : String(err)}`,
                            );
                          } finally {
                            setBpmAnalyzing(false);
                          }
                        }}
                        disabled={bpmAnalyzing}
                        title="Detect BPM from audio"
                      >
                        {bpmAnalyzing ? <Spinner /> : <Waves />}
                      </Button>
                    )}
                    {isChanged("bpm") && (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() =>
                          handleFormChange("bpm", originalFormData.bpm)
                        }
                        title="Reset"
                      >
                        <Undo2 />
                      </Button>
                    )}
                  </div>
                </div>
                <NumberInput
                  value={displayedFormData.bpm}
                  onChange={(v) => handleFormChange("bpm", v)}
                  min={0}
                  max={400}
                  ariaLabel="BPM"
                  testId="bpm-input"
                  className={cn(
                    "h-8 text-xs",
                    isChanged("bpm") && "border-warning/70",
                  )}
                  placeholder="—"
                />
              </div>
            </div>

            {/* 3-col: Release Date | Release Year | Key */}
            <div className="grid grid-cols-[1fr_auto_1fr] gap-2">
              {/* Release Date */}
              <div className="group flex flex-col gap-0.5">
                <div className="flex h-4 items-center justify-between">
                  <span className="text-2xs text-muted-foreground font-medium tracking-wider uppercase">
                    Release Date
                  </span>
                  <div className="flex gap-0.5 opacity-0 transition-opacity duration-150 ease-out group-focus-within:opacity-100 group-hover:opacity-100">
                    <SuggestionButton
                      field="release_date"
                      suggestions={trackSuggestions.release_date}
                      currentValue={formData.release_date}
                      onAccept={(s) => acceptSuggestion("release_date", s)}
                    />
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => handleCopyFromSc("release_date")}
                      disabled={!selectedScTrack}
                      title="Copy from SoundCloud"
                    >
                      <activeSource.Icon className="size-3.5" />
                    </Button>
                    {isChanged("release_date") && (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() =>
                          handleFormChange(
                            "release_date",
                            originalFormData.release_date,
                          )
                        }
                        title="Reset"
                      >
                        <Undo2 />
                      </Button>
                    )}
                  </div>
                </div>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      size="sm"
                      className={`bg-card dark:bg-muted h-8 w-full justify-start px-2.5 text-left text-xs font-normal ${isChanged("release_date") ? "border-warning/70 dark:border-warning/70" : "dark:border-input"} ${!displayedFormData.release_date ? "text-muted-foreground" : "text-foreground"}`}
                    >
                      <CalendarIcon className="mr-1 shrink-0" />
                      {displayedFormData.release_date ? (
                        format(
                          parse(
                            displayedFormData.release_date,
                            "yyyy-MM-dd",
                            new Date(),
                          ),
                          "dd.MM.yyyy",
                        )
                      ) : (
                        <span>Pick date</span>
                      )}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="start">
                    <Calendar
                      mode="single"
                      selected={
                        displayedFormData.release_date &&
                        isValid(
                          parse(
                            displayedFormData.release_date,
                            "yyyy-MM-dd",
                            new Date(),
                          ),
                        )
                          ? parse(
                              displayedFormData.release_date,
                              "yyyy-MM-dd",
                              new Date(),
                            )
                          : undefined
                      }
                      onSelect={(date) =>
                        handleFormChange(
                          "release_date",
                          date ? format(date, "yyyy-MM-dd") : "",
                        )
                      }
                      autoFocus
                    />
                  </PopoverContent>
                </Popover>
              </div>

              {/* Release Year */}
              <div className="group flex w-20 flex-col gap-0.5">
                <div className="flex h-4 items-center justify-between">
                  <span
                    className="text-2xs text-muted-foreground font-medium tracking-wider uppercase"
                    title={
                      yearMismatch
                        ? `Year doesn't match release date (${releaseDateYear})`
                        : undefined
                    }
                  >
                    Year
                    {yearMismatch && (
                      <span className="text-warning/90 ml-0.5">*</span>
                    )}
                  </span>
                  <div className="flex gap-0.5 opacity-0 transition-opacity duration-150 ease-out group-focus-within:opacity-100 group-hover:opacity-100">
                    <SuggestionButton
                      field="release_year"
                      suggestions={trackSuggestions.release_year}
                      currentValue={formData.release_year}
                      onAccept={(s) => acceptSuggestion("release_year", s)}
                    />
                    {isChanged("release_year") && (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => {
                          setReleaseYearTouched(false);
                          handleFormChange(
                            "release_year",
                            originalFormData.release_year,
                          );
                        }}
                        title="Reset"
                      >
                        <Undo2 />
                      </Button>
                    )}
                  </div>
                </div>
                <Input
                  type="number"
                  value={displayedFormData.release_year}
                  onChange={(e) =>
                    handleFormChange("release_year", e.target.value)
                  }
                  className={`h-8 text-xs ${isChanged("release_year") || yearMismatch ? "border-warning/70" : ""}`}
                  placeholder="—"
                />
              </div>

              {/* Key */}
              <div className="group flex flex-col gap-0.5">
                <div className="flex h-4 items-center justify-between">
                  <span className="text-2xs text-muted-foreground font-medium tracking-wider uppercase">
                    Key
                  </span>
                  <div className="flex gap-0.5 opacity-0 transition-opacity duration-150 ease-out group-focus-within:opacity-100 group-hover:opacity-100">
                    <SuggestionButton
                      field="key"
                      suggestions={trackSuggestions.key}
                      currentValue={formData.key}
                      onAccept={(s) => acceptSuggestion("key", s)}
                    />
                    {isChanged("key") && (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() =>
                          handleFormChange("key", originalFormData.key)
                        }
                        title="Reset"
                      >
                        <Undo2 />
                      </Button>
                    )}
                  </div>
                </div>
                <Input
                  value={displayedFormData.key}
                  onChange={(e) => handleFormChange("key", e.target.value)}
                  className={`h-8 text-xs ${isChanged("key") ? "border-warning/70" : ""}`}
                  placeholder="—"
                />
              </div>
            </div>

            {/* Remix fields — flat, always editable. */}
            <div className="grid grid-cols-2 gap-2">
              {/* Original Artist */}
              <div className="group flex flex-col gap-0.5">
                <div className="flex h-4 items-center justify-between">
                  <span className="text-2xs text-muted-foreground font-medium tracking-wider uppercase">
                    Original Artist
                  </span>
                  <div className="flex gap-0.5 opacity-0 transition-opacity duration-150 ease-out group-focus-within:opacity-100 group-hover:opacity-100">
                    <SuggestionButton
                      field="original_artist"
                      suggestions={trackSuggestions.original_artist}
                      currentValue={formData.original_artist}
                      onAccept={(s) => acceptSuggestion("original_artist", s)}
                    />
                    <FieldActionsMenu
                      field="original_artist"
                      actions={[
                        {
                          id: "original_artist-clean",
                          label: "Clean",
                          icon: Eraser,
                          onSelect: () => {
                            if (!formData.original_artist) return;
                            const t = cleanArtist(formData.original_artist);
                            if (t !== formData.original_artist)
                              handleFormChange("original_artist", t);
                          },
                        },
                        {
                          id: "original_artist-titelize",
                          label: "Titelize",
                          icon: Type,
                          onSelect: () => {
                            if (!formData.original_artist) return;
                            const t = titelize(formData.original_artist);
                            if (t !== formData.original_artist)
                              handleFormChange("original_artist", t);
                          },
                        },
                      ]}
                    />
                    {isChanged("original_artist") && (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() =>
                          handleFormChange(
                            "original_artist",
                            originalFormData.original_artist,
                          )
                        }
                        title="Reset"
                      >
                        <Undo2 />
                      </Button>
                    )}
                  </div>
                </div>
                <Input
                  value={displayedFormData.original_artist}
                  onChange={(e) =>
                    handleFormChange("original_artist", e.target.value)
                  }
                  className={`h-8 text-xs ${isChanged("original_artist") ? "border-warning/70" : ""}`}
                  placeholder="—"
                />
              </div>

              {/* Remixer */}
              <div className="group flex flex-col gap-0.5">
                <div className="flex h-4 items-center justify-between">
                  <span className="text-2xs text-muted-foreground font-medium tracking-wider uppercase">
                    Remixer
                  </span>
                  <div className="flex gap-0.5 opacity-0 transition-opacity duration-150 ease-out group-focus-within:opacity-100 group-hover:opacity-100">
                    <SuggestionButton
                      field="remixer"
                      suggestions={trackSuggestions.remixer}
                      currentValue={formData.remixer}
                      onAccept={(s) => acceptSuggestion("remixer", s)}
                    />
                    <FieldActionsMenu
                      field="remixer"
                      actions={[
                        {
                          id: "remixer-clean",
                          label: "Clean",
                          icon: Eraser,
                          onSelect: () => {
                            if (!formData.remixer) return;
                            const t = cleanArtist(formData.remixer);
                            if (t !== formData.remixer)
                              handleFormChange("remixer", t);
                          },
                        },
                        {
                          id: "remixer-titelize",
                          label: "Titelize",
                          icon: Type,
                          onSelect: () => {
                            if (!formData.remixer) return;
                            const t = titelize(formData.remixer);
                            if (t !== formData.remixer)
                              handleFormChange("remixer", t);
                          },
                        },
                      ]}
                    />
                    {isChanged("remixer") && (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() =>
                          handleFormChange("remixer", originalFormData.remixer)
                        }
                        title="Reset"
                      >
                        <Undo2 />
                      </Button>
                    )}
                  </div>
                </div>
                <Input
                  value={displayedFormData.remixer}
                  onChange={(e) => handleFormChange("remixer", e.target.value)}
                  className={`h-8 text-xs ${isChanged("remixer") ? "border-warning/70" : ""}`}
                  placeholder="—"
                />
              </div>
            </div>

            {/* Mix name (full width) */}
            <div className="group flex flex-col gap-0.5">
              <div className="flex h-4 items-center justify-between">
                <span className="text-2xs text-muted-foreground font-medium tracking-wider uppercase">
                  Mix
                </span>
                <div className="flex gap-0.5 opacity-0 transition-opacity duration-150 ease-out group-hover:opacity-100">
                  <SuggestionButton
                    field="mix_name"
                    suggestions={trackSuggestions.mix_name}
                    currentValue={formData.mix_name}
                    onAccept={(s) => acceptSuggestion("mix_name", s)}
                  />
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        title="Predefined mix types"
                      >
                        <ChevronDown />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-36 p-1" align="end">
                      <div className="space-y-0.5">
                        {[
                          "Remix",
                          "VIP Mix",
                          "Extended Mix",
                          "Radio Edit",
                          "Club Mix",
                          "Dub Mix",
                        ].map((opt) => (
                          <Button
                            key={opt}
                            variant="ghost"
                            size="sm"
                            className="w-full justify-start text-xs"
                            onClick={() => handleFormChange("mix_name", opt)}
                          >
                            {opt}
                          </Button>
                        ))}
                      </div>
                    </PopoverContent>
                  </Popover>
                  {isChanged("mix_name") && (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() =>
                        handleFormChange("mix_name", originalFormData.mix_name)
                      }
                      title="Reset"
                    >
                      <Undo2 />
                    </Button>
                  )}
                </div>
              </div>
              <Input
                value={displayedFormData.mix_name}
                onChange={(e) => handleFormChange("mix_name", e.target.value)}
                className={`h-8 text-xs ${isChanged("mix_name") ? "border-warning/70" : ""}`}
                placeholder="—"
              />
            </div>

            {/* User comment — plain text in COMM::eng, separate from StarlibMeta. */}
            <div className="group flex flex-col gap-0.5">
              <div className="flex h-4 items-center justify-between">
                <span className="text-2xs text-muted-foreground font-medium tracking-wider uppercase">
                  Comment
                </span>
                <div className="flex gap-0.5 opacity-0 transition-opacity duration-150 ease-out group-focus-within:opacity-100 group-hover:opacity-100">
                  {isChanged("user_comment") && (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() =>
                        handleFormChange(
                          "user_comment",
                          originalFormData.user_comment,
                        )
                      }
                      title="Reset"
                    >
                      <Undo2 />
                    </Button>
                  )}
                </div>
              </div>
              <textarea
                value={displayedFormData.user_comment}
                onChange={(e) =>
                  handleFormChange("user_comment", e.target.value)
                }
                className={`bg-card dark:bg-muted focus:border-ring focus:ring-ring/50 min-h-16 resize-y rounded-md border px-2.5 py-2 text-xs outline-none focus:ring-1 ${isChanged("user_comment") ? "border-warning/70" : "border-input dark:border-input"}`}
                placeholder="—"
              />
            </div>

            {/* SC link + search */}
            <div className="pt-3">
              <div
                className={`relative rounded-lg border transition-colors duration-200 ${scLinkEnabled ? "border-border bg-accent" : "border-border bg-accent"}`}
              >
                {/* Left chip: SC link toggle */}
                <button
                  data-testid="sc-link-toggle"
                  onClick={() => setScLinkEnabled(!scLinkEnabled)}
                  className={`text-2xs absolute -top-2.75 left-3 inline-flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-0.5 font-semibold tracking-wider uppercase transition-all duration-150 ${
                    scLinkEnabled
                      ? "bg-card text-primary border shadow-sm"
                      : "bg-card text-muted-foreground hover:text-foreground border border-dashed"
                  } ${scMetaChanged ? "border-warning/70" : scLinkEnabled ? "border-border" : "border-border hover:border-border"}`}
                >
                  <activeSource.Icon className="size-2.5" />
                  SoundCloud
                </button>
                {/* Right chip: search toggle */}
                <button
                  onClick={() => setScSidebarOpen(!scSidebarOpen)}
                  className={`text-2xs absolute -top-2.75 right-3 inline-flex cursor-pointer items-center gap-1 rounded-md border px-2 py-0.5 font-semibold tracking-wider uppercase transition-all duration-150 ${
                    scSidebarOpen
                      ? "bg-card border-border text-primary shadow-sm"
                      : "bg-card border-border text-muted-foreground hover:text-foreground hover:border-border border-dashed"
                  }`}
                  title={scSidebarOpen ? "Close search" : "Search SoundCloud"}
                >
                  {scSidebarOpen ? (
                    <X className="size-2.5" />
                  ) : (
                    <Search className="size-2.5" />
                  )}
                  {scSidebarOpen ? "Close" : "Search"}
                </button>

                {/* Link row */}
                <div
                  className={`group flex items-center gap-3 px-3 pt-3 pb-2 transition-opacity duration-150 ${scLinkEnabled ? "opacity-100" : "pointer-events-none opacity-40"}`}
                >
                  <div className="min-w-0 flex-1">
                    {commentData.soundcloud_id ? (
                      <a
                        href={
                          commentData.soundcloud_permalink ||
                          `https://soundcloud.com/tracks/${commentData.soundcloud_id}`
                        }
                        target="_blank"
                        rel="noopener noreferrer"
                        className={`hover:text-foreground block truncate text-xs transition-colors ${commentData.soundcloud_id !== originalCommentData.soundcloud_id || commentData.soundcloud_permalink !== originalCommentData.soundcloud_permalink ? "text-warning/90" : "text-muted-foreground"}`}
                      >
                        {commentData.soundcloud_permalink ||
                          `ID: ${commentData.soundcloud_id}`}
                      </a>
                    ) : (
                      <span
                        className={`text-xs ${commentData.soundcloud_id !== originalCommentData.soundcloud_id || commentData.soundcloud_permalink !== originalCommentData.soundcloud_permalink ? "text-warning/90" : "text-muted-foreground"}`}
                      >
                        No SoundCloud track linked
                      </span>
                    )}
                  </div>
                  <TooltipProvider delayDuration={300}>
                    <div className="flex shrink-0 scale-75 gap-0.5 opacity-0 transition-all duration-150 ease-out group-hover:scale-100 group-hover:opacity-100">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            onClick={() => {
                              if (!selectedScTrack) return;
                              const meta =
                                activeSource.extractMetadata(selectedScTrack);
                              setCommentData({
                                soundcloud_id: meta.source_id,
                                soundcloud_permalink: meta.source_permalink,
                              });
                              setScLinkEnabled(true);
                            }}
                            disabled={!selectedScTrack}
                            data-testid="link-sc-track-button"
                            aria-label="Link selected SoundCloud track to this file"
                          >
                            <Link2 className="size-3" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent side="top" sideOffset={4}>
                          {selectedScTrack
                            ? "Link selected SoundCloud track"
                            : "Pick a SoundCloud track in the search panel first"}
                        </TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            onClick={() =>
                              setCommentData({
                                soundcloud_id: "",
                                soundcloud_permalink: "",
                              })
                            }
                            disabled={
                              !commentData.soundcloud_id &&
                              !commentData.soundcloud_permalink
                            }
                            aria-label="Clear SoundCloud link"
                          >
                            <Trash2 />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent side="top" sideOffset={4}>
                          Clear link
                        </TooltipContent>
                      </Tooltip>
                      {(commentData.soundcloud_id !==
                        originalCommentData.soundcloud_id ||
                        commentData.soundcloud_permalink !==
                          originalCommentData.soundcloud_permalink) && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon-xs"
                              onClick={() =>
                                setCommentData(originalCommentData)
                              }
                              aria-label="Reset SoundCloud link"
                            >
                              <RotateCcw />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent side="top" sideOffset={4}>
                            Reset
                          </TooltipContent>
                        </Tooltip>
                      )}
                    </div>
                  </TooltipProvider>
                </div>

                {/* Compact track preview (search closed, track selected) */}
                {!scSidebarOpen && selectedScTrack && (
                  <div className="border-border flex items-center gap-2 border-t px-3 pt-0 pb-2">
                    <div className="border-border mt-1.5 size-5 shrink-0 overflow-hidden rounded border">
                      {selectedScTrack.artwork_url ? (
                        <img
                          src={selectedScTrack.artwork_url}
                          alt=""
                          className="size-full object-cover"
                        />
                      ) : (
                        <div className="bg-accent flex size-full items-center justify-center">
                          <ImageIcon className="text-muted-foreground size-3" />
                        </div>
                      )}
                    </div>
                    <span className="text-muted-foreground mt-1.5 truncate text-xs">
                      {selectedScTrack.title}
                    </span>
                  </div>
                )}

                {/* Expanded search UI */}
                {scSidebarOpen && (
                  <div className="border-border border-t">
                    <div
                      className={`px-3 py-2.5 ${selectedScTrack || scResults.length > 0 ? "border-border border-b" : ""}`}
                    >
                      <div className="flex gap-2">
                        <Input
                          value={scQuery}
                          onChange={(e) => setScQuery(e.target.value)}
                          placeholder="Search tracks..."
                          onKeyDown={(e) =>
                            e.key === "Enter" && handleScSearch()
                          }
                          className="h-8 text-xs"
                          autoFocus
                        />
                        <Button
                          onClick={handleScSearch}
                          disabled={scSearching || !scQuery.trim()}
                          size="sm"
                          className="h-8 shrink-0 px-2.5"
                        >
                          <Search className="size-3.5" />
                        </Button>
                      </div>
                    </div>

                    {selectedScTrack && (
                      <div className="border-border space-y-2 border-b px-3 py-3">
                        <a
                          href={selectedScTrack.permalink_url ?? undefined}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="group/sclink flex items-center gap-2.5"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <div className="size-8 shrink-0 overflow-hidden rounded border">
                            {selectedScTrack.artwork_url ? (
                              <img
                                src={selectedScTrack.artwork_url}
                                alt=""
                                className="size-full object-cover"
                              />
                            ) : (
                              <div className="bg-accent flex size-full items-center justify-center">
                                <ImageIcon className="text-muted-foreground size-3" />
                              </div>
                            )}
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="text-foreground group-hover/sclink:text-primary truncate text-xs font-medium transition-colors">
                              {selectedScTrack.title}
                            </div>
                            <div className="text-muted-foreground flex items-center gap-1 truncate text-xs">
                              <activeSource.Icon className="size-2.5 shrink-0" />
                              {selectedScTrack.username}
                            </div>
                          </div>
                        </a>
                        {activeSource.getEmbedUrl(selectedScTrack, isDark) && (
                          <iframe
                            width="100%"
                            height="120"
                            scrolling="no"
                            frameBorder="no"
                            allow="autoplay"
                            src={activeSource.getEmbedUrl(
                              selectedScTrack,
                              isDark,
                            )!}
                            className="overflow-hidden rounded-lg"
                          />
                        )}
                        <div className="flex gap-1.5">
                          <Button
                            onClick={() => {
                              handleApplyScMetadata(selectedScTrack);
                              setScSidebarOpen(false);
                            }}
                            disabled={!trackInfo}
                            size="sm"
                            className="h-7 flex-1 text-xs"
                          >
                            Apply All
                          </Button>
                          <Button
                            onClick={() => setSelectedScTrack(null)}
                            variant="ghost"
                            size="sm"
                            className="h-7 text-xs"
                          >
                            Clear
                          </Button>
                        </div>
                      </div>
                    )}

                    {scResults.map((track, i) => (
                      <button
                        key={track.id}
                        onClick={() => handleScTrackSelect(track)}
                        className={`relative w-full cursor-pointer overflow-hidden px-3 py-2 text-left transition-colors ${
                          i === scResults.length - 1 ? "rounded-b-lg" : ""
                        } ${
                          selectedScTrack?.id === track.id
                            ? "bg-brand-soft text-foreground"
                            : "text-muted-foreground hover:text-foreground hover:bg-accent"
                        }`}
                      >
                        {selectedScTrack?.id === track.id && (
                          <div className="bg-primary absolute inset-y-0 left-0 w-0.5 rounded-r" />
                        )}
                        <div className="flex items-center gap-2.5">
                          <div className="border-border size-8 shrink-0 overflow-hidden rounded border">
                            {track.artwork_url ? (
                              <img
                                src={track.artwork_url}
                                alt=""
                                className="size-full object-cover"
                                loading="lazy"
                              />
                            ) : (
                              <div className="bg-accent flex size-full items-center justify-center">
                                <ImageIcon className="text-muted-foreground size-3" />
                              </div>
                            )}
                          </div>
                          <div className="min-w-0">
                            <div className="truncate text-xs font-medium">
                              {track.title}
                            </div>
                            <div className="truncate text-xs opacity-60">
                              {track.username}
                              {track.genre ? ` · ${track.genre}` : ""}
                            </div>
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Actions */}
          <div className="border-border flex shrink-0 items-center gap-1 border-t px-3 py-2.5">
            {/* Save */}
            <Button
              onClick={handleSave}
              disabled={!hasChanges || loading || applying}
              variant="ghost"
              size="sm"
              className={cn(
                "h-7 gap-1.5 px-2.5 text-xs",
                hasChanges
                  ? "text-primary hover:bg-brand-soft hover:text-primary"
                  : "text-muted-foreground",
              )}
            >
              {loading ? (
                <LogoSpinner className="size-3" />
              ) : (
                <Check className="size-3" />
              )}
              Save
            </Button>

            {/* Apply Rules — shown only when folder has a ruleset */}
            {activeRuleset?.rules.length
              ? (() => {
                  const gate = applyRulesGate({
                    loading,
                    hasUnsavedChanges: hasChanges,
                    hasMissingRequired,
                  });
                  // `applying` is layered on top of the gate: the gate decides
                  // whether the *next* click is allowed, `applying` blocks
                  // re-firing while a request is in flight (#375).
                  const blocked = gate.disabled || applying;
                  return (
                    <TooltipProvider
                      delayDuration={400}
                      disableHoverableContent
                    >
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            onClick={blocked ? undefined : handleApplyRules}
                            aria-disabled={blocked || undefined}
                            data-testid="apply-rules-button"
                            data-applying={applying ? "true" : undefined}
                            data-gate-reason={gate.reason ?? ""}
                            variant="ghost"
                            size="sm"
                            className={cn(
                              "h-7 gap-1 text-xs",
                              blocked
                                ? "text-muted-foreground cursor-not-allowed opacity-50"
                                : "text-primary hover:bg-primary/10 hover:text-primary",
                            )}
                          >
                            {applying ? (
                              <Spinner className="size-3" />
                            ) : (
                              <Workflow className="size-3" />
                            )}
                            {applying ? "Applying…" : "Apply rules"}
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent
                          side="top"
                          sideOffset={6}
                          showArrow={false}
                          className="bg-popover text-popover-foreground max-w-64 border p-0"
                        >
                          {applying ? (
                            <p className="px-3 py-2 text-xs">
                              Applying rules — file conversion runs in the
                              background, the rest of the app stays usable.
                            </p>
                          ) : gate.reason === "unsaved" ? (
                            <p className="px-3 py-2 text-xs">
                              Save your changes before applying rules.
                            </p>
                          ) : (
                            <RulesetPreview
                              ruleset={activeRuleset}
                              missingRequired={
                                hasMissingRequired
                                  ? missingRequiredAttrs
                                  : undefined
                              }
                            />
                          )}
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  );
                })()
              : null}
            <div className="flex-1" />
            <Button
              onClick={handleDelete}
              disabled={loading || applying}
              variant="ghost"
              size="icon-xs"
              className="text-muted-foreground hover:text-destructive"
            >
              <Trash2 />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
