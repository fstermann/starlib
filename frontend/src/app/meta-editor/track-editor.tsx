'use client';

import { useState, useEffect, useLayoutEffect } from 'react';
import { useTheme } from 'next-themes';
import { api, type FileInfo, type TrackInfo, type TrackInfoUpdateRequest, type Ruleset, type RuleType } from '@/lib/api';
import { cleanTitle, cleanArtist, titelize, removeParenthesis, parseFilename, parseRemix, removeMix } from '@/lib/string-utils';
import { soundCloudSource } from '@/lib/sources/soundcloud';
import type { SourceTrack } from '@/lib/sources/types';
import { format, parse, isValid } from 'date-fns';
import { toast } from 'sonner';
import { useSourceSearch } from './use-source-search';
import { parseComment, serializeComment } from './utils';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Input } from '@/components/ui/input';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Calendar } from '@/components/ui/calendar';
import { LogoSpinner } from '@/components/logo-spinner';
import { StepBadge, RULE_ICONS, RULE_ICON_COLORS } from '@/components/rulesets/rule-card';
import { SoundCloudLogo } from '@/components/icons/soundcloud-logo';
import {
  Sparkles,
  CaseSensitive,
  Trash2,
  Brackets,
  Wand2,
  Users,
  Image,
  CalendarIcon,
  Search,
  RotateCcw,
  ChevronDown,
  X,
  MoveRight,
} from 'lucide-react';

export interface AutoActions {
  autoCopyArtwork: boolean;
  autoCopyMetadata: boolean;
  autoClean: boolean;
  autoTitelize: boolean;
  autoRemoveOriginalMix: boolean;
  autoApplyScResults: boolean;
}

export interface TrackEditorProps {
  selectedFile: FileInfo;
  folderMode: string;
  folderRulesetId: string | null;
  autoActions: AutoActions;
  onTableRefresh: () => void;
  onClose: () => void;
  /** Called after save to update the parent's selectedFile reference (may have new path). */
  onFileChange: (file: FileInfo) => void;
  /** Called after finalize — selects the next track in the list. */
  onSelectNext: (currentFilePath: string) => void;
}

export function TrackEditor({ selectedFile, folderMode, folderRulesetId, autoActions, onTableRefresh, onClose, onFileChange, onSelectNext }: TrackEditorProps) {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';

  // Track loading
  const [trackInfo, setTrackInfo] = useState<TrackInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Source search panel
  const [scSidebarOpen, setScSidebarOpen] = useState(false);
  const activeSource = soundCloudSource;

  const sc = useSourceSearch(activeSource, true, setError);
  const { query: scQuery, setQuery: setScQuery, results: scResults, searching: scSearching,
          queryPending: scQueryPending, setQueryPending: setScQueryPending,
          selectedTrack: selectedScTrack, setSelectedTrack: setSelectedScTrack,
          handleSearch: handleScSearch, handleTrackSelect: handleScTrackSelect } = sc;

  // Remix state
  const [isRemix, setIsRemix] = useState(false);
  const [remixData, setRemixData] = useState({ original_artist: '', remixer: '', mix_name: 'Remix' });

  // Artwork state
  const [artworkUrl, setArtworkUrl] = useState<string | null>(null);
  const [pendingArtworkData, setPendingArtworkData] = useState<string | null>(null);
  const [artworkPreviewOpen, setArtworkPreviewOpen] = useState(false);

  // Metadata form state
  const [formData, setFormData] = useState({
    title: '',
    artist: '',
    bpm: '',
    key: '',
    genre: '',
    release_date: '',
  });

  // Original values for change detection
  const [originalFormData, setOriginalFormData] = useState({
    title: '',
    artist: '',
    bpm: '',
    key: '',
    genre: '',
    release_date: '',
  });

  // Structured comment state (SC ID + permalink)
  const [commentData, setCommentData] = useState({ soundcloud_id: '', soundcloud_permalink: '' });
  const [scLinkEnabled, setScLinkEnabled] = useState(true);

  // Active ruleset (shown in Apply Rules popover) — only set when the folder has one assigned
  const [activeRuleset, setActiveRuleset] = useState<Ruleset | null>(null);
  useEffect(() => {
    if (folderRulesetId) {
      api.getRulesets()
        .then((data) => setActiveRuleset(data.rulesets.find((r) => r.id === folderRulesetId) ?? null))
        .catch(() => setActiveRuleset(null));
    } else {
      setActiveRuleset(null);
    }
  }, [folderRulesetId]);

  // Original values for remix/SC-link change detection
  const [originalIsRemix, setOriginalIsRemix] = useState(false);
  const [originalRemixData, setOriginalRemixData] = useState({ original_artist: '', remixer: '', mix_name: 'Remix' });
  const [originalScLinkEnabled, setOriginalScLinkEnabled] = useState(true);
  const [originalCommentData, setOriginalCommentData] = useState({ soundcloud_id: '', soundcloud_permalink: '' });

  // Confirm dialog
  const [confirmDialog, setConfirmDialog] = useState<{ open: boolean; message: string; onConfirm: () => void }>({
    open: false,
    message: '',
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
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load track info');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [selectedFile.file_path]);

  // Auto-fill empty form fields when a source track is selected
  useLayoutEffect(() => {
    setScQueryPending(false);

    if (!selectedScTrack || !autoActions.autoCopyMetadata) return;

    const meta = activeSource.extractMetadata(selectedScTrack);

    setFormData(prev => ({
      ...prev,
      title: prev.title || selectedScTrack.title || '',
      artist: prev.artist || selectedScTrack.username || '',
      genre: prev.genre || selectedScTrack.genre || '',
      release_date: prev.release_date || meta.release_date || '',
    }));

    setCommentData(prev => ({
      soundcloud_id: prev.soundcloud_id || meta.source_id,
      soundcloud_permalink: prev.soundcloud_permalink || meta.source_permalink,
    }));
    setScLinkEnabled(true);
  }, [selectedScTrack, autoActions.autoCopyMetadata]);

  // Show source artwork in preview when no existing artwork
  useEffect(() => {
    if (!selectedScTrack || !autoActions.autoCopyArtwork || !trackInfo || trackInfo.has_artwork) return;

    const hqUrl = activeSource.extractMetadata(selectedScTrack).artwork_url;
    if (!hqUrl) return;

    setArtworkUrl(hqUrl);
    api.proxyImage(hqUrl).then((blob) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const b64 = (reader.result as string).split(',')[1];
        setPendingArtworkData(b64);
      };
      reader.readAsDataURL(blob);
    }).catch(() => {/* non-fatal */});
  }, [selectedScTrack, autoActions.autoCopyArtwork, trackInfo?.has_artwork]);

  // Update form when track info loads
  useEffect(() => {
    if (!trackInfo) return;

    const parsed = parseFilename(trackInfo.file_name);
    const artistStr = Array.isArray(trackInfo.artist) ? trackInfo.artist.join(', ') : (trackInfo.artist ?? '');
    const remixerStr = Array.isArray(trackInfo.remixer) ? trackInfo.remixer.join(', ') : (trackInfo.remixer ?? '');
    const originalArtistStr = Array.isArray(trackInfo.original_artist) ? trackInfo.original_artist.join(', ') : (trackInfo.original_artist ?? '');
    const newFormData = {
      title: trackInfo.title || parsed.title || '',
      artist: artistStr || parsed.artist || '',
      bpm: trackInfo.bpm?.toString() || '',
      key: trackInfo.key || '',
      genre: trackInfo.genre || '',
      release_date: trackInfo.release_date || '',
    };
    setFormData(newFormData);
    setOriginalFormData(newFormData);
    const parsedComment = parseComment(trackInfo.starlib_meta);
    setCommentData(parsedComment);
    setScLinkEnabled(!!(parsedComment.soundcloud_id || parsedComment.soundcloud_permalink));

    if (remixerStr) {
      setIsRemix(true);
      setRemixData({ original_artist: originalArtistStr || artistStr, remixer: remixerStr, mix_name: trackInfo.mix_name || 'Remix' });
    } else {
      const titleToCheck = trackInfo.title || parsed.title || '';
      const detected = titleToCheck ? parseRemix(titleToCheck) : null;
      if (detected) {
        setIsRemix(true);
        setRemixData({ original_artist: originalArtistStr || artistStr || parsed.artist || '', remixer: detected.remixer, mix_name: trackInfo.mix_name || detected.mixName });
      } else {
        setIsRemix(false);
        setRemixData({ original_artist: '', remixer: '', mix_name: 'Remix' });
      }
    }

    const initialIsRemix = !!remixerStr || !!(trackInfo.title && parseRemix(trackInfo.title));
    setOriginalIsRemix(initialIsRemix);
    setOriginalRemixData(
      remixerStr
        ? { original_artist: originalArtistStr || artistStr, remixer: remixerStr, mix_name: trackInfo.mix_name || 'Remix' }
        : { original_artist: '', remixer: '', mix_name: 'Remix' }
    );
    const initialScLinkEnabled = !!(parsedComment.soundcloud_id || parsedComment.soundcloud_permalink);
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
      const cleaned = removeMix(trackInfo.file_name
        .replace(/\.(mp3|aiff|wav)$/i, '')
        .replace(/_/g, ' ')
        .replace(/\[.*?\]/g, '')
        .trim());
      setScQuery(cleaned);
      setScQueryPending(true);
    }
  }, [trackInfo]);

  const reloadTrackInfo = async (file: FileInfo) => {
    setLoading(true);
    setError(null);
    try {
      const info = await api.getTrackInfo(file.file_path);
      setTrackInfo(info);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load track info');
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
      const b64 = (reader.result as string).split(',')[1];
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

    showConfirm('Remove artwork from this file?', async () => {
      try {
        setLoading(true);
        await api.removeArtwork(trackInfo.file_path);
        setArtworkUrl(null);
        await reloadTrackInfo(selectedFile);
        toast.success('Artwork removed successfully');
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to remove artwork');
      } finally {
        setLoading(false);
      }
    });
  };

  const handleRemixChange = (field: string, value: string) => {
    setRemixData(prev => ({ ...prev, [field]: value }));
  };

  const handleCleanTitle = () => {
    if (!formData.title) return;
    const transformed = cleanTitle(formData.title);
    if (transformed !== formData.title) setFormData({ ...formData, title: transformed });
  };

  const handleCleanArtist = () => {
    if (!formData.artist) return;
    const transformed = cleanArtist(formData.artist);
    if (transformed !== formData.artist) setFormData({ ...formData, artist: transformed });
  };

  const handleRemoveParenthesis = () => {
    if (!formData.title) return;
    const transformed = removeParenthesis(formData.title);
    if (transformed !== formData.title) setFormData({ ...formData, title: transformed });
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
      setFormData({ ...formData, [field]: fieldMap[field] || '' });
    }
  };

  const scArtistOptions = selectedScTrack?.artist_options ?? [];

  const handleBuildTitleFromRemix = () => {
    if (!isRemix || !remixData.original_artist || !remixData.remixer) return;
    const rawTitle = formData.title.replace(/\(.*?\)/g, '').trim();
    const newTitle = `${remixData.original_artist} - ${rawTitle} (${remixData.remixer} ${remixData.mix_name})`;
    setFormData({ ...formData, title: newTitle });
  };

  const handleIsolateTitle = () => {
    if (!formData.title) return;
    const match = formData.title.match(/.*?\s*-\s*([^(]*)/);
    if (match) {
      setFormData({ ...formData, title: match[1].trim() });
    }
  };

  const isChanged = (field: keyof typeof formData) => formData[field] !== originalFormData[field];

  const scBusy = (scSearching || scQueryPending) && !commentData.soundcloud_id && !commentData.soundcloud_permalink;
  const hasChanges = scBusy || pendingArtworkData !== null ||
    (Object.keys(formData) as (keyof typeof formData)[]).some(k => formData[k] !== originalFormData[k]) ||
    isRemix !== originalIsRemix ||
    remixData.original_artist !== originalRemixData.original_artist ||
    remixData.remixer !== originalRemixData.remixer ||
    remixData.mix_name !== originalRemixData.mix_name ||
    scLinkEnabled !== originalScLinkEnabled ||
    commentData.soundcloud_id !== originalCommentData.soundcloud_id ||
    commentData.soundcloud_permalink !== originalCommentData.soundcloud_permalink;

  const formComplete =
    !!formData.title && !!formData.artist && !!formData.genre && !!formData.release_date && !!artworkUrl;

  const handleFormChange = (field: string, value: string | number) => {
    setFormData(prev => ({ ...prev, [field]: value }));
  };

  const handleSave = async () => {
    if (!trackInfo) return;

    try {
      setLoading(true);
      setError(null);

      const updates: Record<string, string | number | string[] | null> = {};
      Object.entries(formData).forEach(([key, value]) => {
        if (value !== '') {
          if (key === 'bpm') {
            updates[key] = parseInt(value as string);
          } else {
            updates[key] = value;
          }
        }
      });

      const starlibStr = serializeComment(
        scLinkEnabled ? commentData.soundcloud_id : '',
        scLinkEnabled ? commentData.soundcloud_permalink : '',
      );
      if (starlibStr) updates.starlib_meta = starlibStr;

      if (isRemix && remixData.remixer) {
        updates.remixer = remixData.remixer;
        updates.original_artist = remixData.original_artist || null;
        updates.mix_name = remixData.mix_name || null;
      } else {
        updates.remixer = null;
        updates.original_artist = null;
        updates.mix_name = null;
      }

      if (pendingArtworkData) {
        updates.artwork_data = pendingArtworkData;
      }

      const result = await api.updateTrackInfo(trackInfo.file_path, updates as TrackInfoUpdateRequest);
      const newFilePath = result.new_file_path ?? trackInfo.file_path;
      const newFileInfo: FileInfo = {
        ...selectedFile,
        file_path: newFilePath,
        file_name: newFilePath.split('/').pop() ?? selectedFile.file_name,
      };
      onTableRefresh();
      onFileChange(newFileInfo);
      await reloadTrackInfo(newFileInfo);
      toast.success('Metadata saved successfully');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save metadata');
    } finally {
      setLoading(false);
    }
  };

  const handleFinalize = () => {
    if (!trackInfo) return;
    const filePathToFinalize = trackInfo.file_path;
    const trackName = formData.title || selectedFile.file_name || filePathToFinalize;
    const toastId = toast.loading(`Applying rules to "${trackName}"…`);
    api.finalizeTrack(filePathToFinalize, {})
      .then((result) => {
        const steps = result.steps ?? [];
        toast.success(
          <div className="flex flex-col gap-1">
            <span className="font-medium text-sm">{trackName}</span>
            {steps.length > 0 && (
              <div className="flex flex-col gap-0.5 mt-0.5">
                {steps.map((step, i) => {
                  const Icon = RULE_ICONS[step.type as RuleType] ?? MoveRight;
                  const color = RULE_ICON_COLORS[step.type as RuleType] ?? 'text-muted-foreground';
                  return (
                    <div key={i} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Icon className={`size-3 shrink-0 ${step.status === 'skipped' ? 'opacity-30' : color}`} />
                      <span className={step.status === 'skipped' ? 'line-through opacity-50' : ''}>{step.message}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>,
          { id: toastId },
        );
        onSelectNext(filePathToFinalize);
        onTableRefresh();
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : 'Failed to apply rules';
        toast.error(message, { id: toastId, duration: Infinity });
      });
  };

  const handleDelete = () => {
    if (!trackInfo) return;
    showConfirm('Are you sure you want to delete this file?', async () => {
      try {
        setLoading(true);
        setError(null);
        await api.deleteFile(trackInfo.file_path);
        onTableRefresh();
        onClose();
        toast.success('File deleted successfully');
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to delete file');
      } finally {
        setLoading(false);
      }
    });
  };

  const handleApplyScMetadata = (track: SourceTrack) => {
    const meta = activeSource.extractMetadata(track);

    setFormData(prev => ({
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
      api.proxyImage(meta.artwork_url).then((blob) => {
        const reader = new FileReader();
        reader.onloadend = () => {
          const b64 = (reader.result as string).split(',')[1];
          setPendingArtworkData(b64);
        };
        reader.readAsDataURL(blob);
      }).catch(() => {/* non-fatal */});
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Artwork lightbox preview */}
      {artworkPreviewOpen && artworkUrl && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
          onClick={() => setArtworkPreviewOpen(false)}
        >
          <img
            src={artworkUrl}
            alt="Artwork preview"
            className="max-w-[min(500px,90vw)] max-h-[90vh] rounded-xl shadow-2xl object-contain"
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
            <AlertDialogDescription>{confirmDialog.message}</AlertDialogDescription>
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

      {/* Panel header: filename + close */}
      <div className="px-3 h-10 flex items-center justify-between border-b border-border/50 shrink-0">
        <span className="text-xs text-muted-foreground truncate min-w-0 mr-2">{trackInfo?.file_name ?? selectedFile.file_name}</span>
        <button
          onClick={onClose}
          className="cursor-pointer shrink-0 size-5 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
          title="Close editor"
        >
          <X className="size-3" />
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="mx-3 mt-2 shrink-0 bg-destructive/10 border border-destructive/20 text-destructive text-xs px-3 py-2 rounded-lg">
          {error}
        </div>
      )}

      {/* Skeleton while loading */}
      {loading && !trackInfo && (
        <div className="px-3 pt-3 flex flex-col gap-3">
          <div className="flex gap-3 items-start">
            <Skeleton className="size-21.5 rounded-lg shrink-0" />
            <div className="flex-1 flex flex-col gap-1.5 pt-5">
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
        <div className="flex-1 min-h-0 flex flex-col">
          <div className="px-3 py-3 flex flex-col gap-3 overflow-y-auto flex-1 min-h-0">

            {/* Artwork + Title + Artist */}
            <div className="flex gap-3 items-start">
              {/* Artwork */}
              <div className="group flex flex-col gap-0.5 shrink-0 items-center">
                <div className="flex items-center justify-between h-4">
                  <div className="flex gap-0.5 opacity-0 scale-75 group-hover:opacity-100 group-hover:scale-100 transition-all duration-150 ease-out">
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      title="Copy artwork from SoundCloud"
                      disabled={!selectedScTrack?.artwork_url}
                      onClick={() => {
                        if (!selectedScTrack) return;
                        const hqUrl = activeSource.extractMetadata(selectedScTrack).artwork_url;
                        if (!hqUrl) return;
                        setArtworkUrl(hqUrl);
                        api.proxyImage(hqUrl).then((blob) => {
                          const reader = new FileReader();
                          reader.onloadend = () => {
                            const b64 = (reader.result as string).split(',')[1];
                            setPendingArtworkData(b64);
                          };
                          reader.readAsDataURL(blob);
                        }).catch(() => {});
                      }}
                    ><activeSource.Icon className="size-3"  /></Button>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      title="Change artwork"
                      onClick={() => {
                        const input = document.createElement('input');
                        input.type = 'file';
                        input.accept = 'image/*';
                        input.onchange = handleArtworkUpload as any;
                        input.click();
                      }}
                    ><Image /></Button>
                    {artworkUrl && (
                      <Button variant="ghost" size="icon-xs" title="Remove artwork" className="hover:text-destructive" onClick={handleRemoveArtwork}><Trash2 /></Button>
                    )}
                  </div>
                </div>
                <div
                  className={`relative size-21.5 rounded-lg overflow-hidden border ${pendingArtworkData ? 'border-amber-400/70' : 'border-border/50'} ${artworkUrl ? 'cursor-zoom-in' : 'cursor-pointer'}`}
                  onClick={() => {
                    if (artworkUrl) {
                      setArtworkPreviewOpen(true);
                    } else {
                      const input = document.createElement('input');
                      input.type = 'file';
                      input.accept = 'image/*';
                      input.onchange = handleArtworkUpload as any;
                      input.click();
                    }
                  }}
                >
                  {artworkUrl ? (
                    <img src={artworkUrl} alt="Artwork" className="size-full object-cover" />
                  ) : (
                    <div className="size-full bg-accent/50 flex flex-col items-center justify-center gap-0.5 hover:bg-accent transition-colors">
                      <Image className="size-3 text-muted-foreground" />
                      <span className="text-[8px] text-muted-foreground">N/A</span>
                    </div>
                  )}
                </div>
              </div>

              {/* Title + Artist stacked */}
              <div className="flex-1 min-w-0 flex flex-col gap-1">
                {/* Title */}
                <div className="group flex flex-col gap-0.5">
                  <div className="flex items-center justify-between h-4">
                    <span className="text-[9px] uppercase tracking-wider text-muted-foreground font-medium">Title</span>
                    <div className="flex gap-0.5 opacity-0 scale-75 group-hover:opacity-100 group-hover:scale-100 group-focus-within:opacity-100 group-focus-within:scale-100 transition-all duration-150 ease-out">
                      <Button variant="ghost" size="icon-xs" onClick={() => handleCopyFromSc('title')} disabled={!selectedScTrack} title="Copy from SoundCloud"><activeSource.Icon className="size-3"  /></Button>
                      <Button variant="ghost" size="icon-xs" onClick={handleCleanTitle} title="Clean"><Sparkles /></Button>
                      <Button variant="ghost" size="icon-xs" onClick={() => { if (!formData.title) return; const t = titelize(formData.title); if (t !== formData.title) setFormData({...formData, title: t}); }} title="Titelize"><CaseSensitive /></Button>
                      <Button variant="ghost" size="icon-xs" onClick={handleBuildTitleFromRemix} disabled={!isRemix} title="Build from remix"><Wand2 /></Button>
                      <Button variant="ghost" size="icon-xs" onClick={handleRemoveParenthesis} title="Remove brackets"><Brackets /></Button>
                      <Button variant="ghost" size="icon-xs" onClick={handleIsolateTitle} title="Isolate"><Trash2 /></Button>
                      {isChanged('title') && <Button variant="ghost" size="icon-xs" onClick={() => handleFormChange('title', originalFormData.title)} title="Reset"><RotateCcw /></Button>}
                    </div>
                  </div>
                  <Input value={formData.title} onChange={(e) => handleFormChange('title', e.target.value)} className={`h-8 text-xs${isChanged('title') ? ' border-amber-400/70' : ''}`} placeholder="Title" />
                </div>

                {/* Artist */}
                <div className="group flex flex-col gap-0.5">
                  <div className="flex items-center justify-between h-4">
                    <span className="text-[9px] uppercase tracking-wider text-muted-foreground font-medium">Artist</span>
                    <div className="flex gap-0.5 opacity-0 scale-75 group-hover:opacity-100 group-hover:scale-100 group-focus-within:opacity-100 group-focus-within:scale-100 transition-all duration-150 ease-out">
                      <Button variant="ghost" size="icon-xs" onClick={() => handleCopyFromSc('artist')} disabled={!selectedScTrack} title="Copy from SoundCloud"><activeSource.Icon className="size-3"  /></Button>
                      <Button variant="ghost" size="icon-xs" onClick={handleCleanArtist} title="Clean"><Sparkles /></Button>
                      <Button variant="ghost" size="icon-xs" onClick={() => { if (!formData.artist) return; const t = titelize(formData.artist); if (t !== formData.artist) setFormData({...formData, artist: t}); }} title="Titelize"><CaseSensitive /></Button>
                      <Popover>
                        <PopoverTrigger asChild>
                          <Button variant="ghost" size="icon-xs" disabled={!selectedScTrack || !scArtistOptions.length} title="Artist options"><Users /></Button>
                        </PopoverTrigger>
                        <PopoverContent className="w-48 p-2">
                          <div className="space-y-1">
                            {scArtistOptions.map((artist) => (
                              <Button key={artist} variant="ghost" size="sm" className="w-full justify-start text-xs" onClick={() => setFormData({ ...formData, artist })}>{artist}</Button>
                            ))}
                          </div>
                        </PopoverContent>
                      </Popover>
                      {isChanged('artist') && <Button variant="ghost" size="icon-xs" onClick={() => handleFormChange('artist', originalFormData.artist)} title="Reset"><RotateCcw /></Button>}
                    </div>
                  </div>
                  <Input value={formData.artist} onChange={(e) => handleFormChange('artist', e.target.value)} className={`h-8 text-xs${isChanged('artist') ? ' border-amber-400/70' : ''}`} placeholder="Artist" />
                </div>
              </div>
            </div>

            {/* 2-col: Genre | BPM */}
            <div className="grid grid-cols-2 gap-2">
              {/* Genre */}
              <div className="group flex flex-col gap-0.5">
                <div className="flex items-center justify-between h-4">
                  <span className="text-[9px] uppercase tracking-wider text-muted-foreground font-medium">Genre</span>
                  <div className="flex gap-0.5 opacity-0 scale-75 group-hover:opacity-100 group-hover:scale-100 group-focus-within:opacity-100 group-focus-within:scale-100 transition-all duration-150 ease-out">
                    <Button variant="ghost" size="icon-xs" onClick={() => handleCopyFromSc('genre')} disabled={!selectedScTrack} title="Copy from SC"><activeSource.Icon className="size-3"  /></Button>
                    <Button variant="ghost" size="icon-xs" onClick={() => { if (!formData.genre) return; const t = titelize(formData.genre); if (t !== formData.genre) setFormData({...formData, genre: t}); }} title="Titelize"><CaseSensitive /></Button>
                    {isChanged('genre') && <Button variant="ghost" size="icon-xs" onClick={() => handleFormChange('genre', originalFormData.genre)} title="Reset"><RotateCcw /></Button>}
                  </div>
                </div>
                <Input value={formData.genre} onChange={(e) => handleFormChange('genre', e.target.value)} className={`h-8 text-xs${isChanged('genre') ? ' border-amber-400/70' : ''}`} placeholder="—" />
              </div>

              {/* BPM */}
              <div className="group flex flex-col gap-0.5">
                <div className="flex items-center justify-between h-4">
                  <span className="text-[9px] uppercase tracking-wider text-muted-foreground font-medium">BPM</span>
                  <div className="flex gap-0.5 opacity-0 scale-75 group-hover:opacity-100 group-hover:scale-100 group-focus-within:opacity-100 group-focus-within:scale-100 transition-all duration-150 ease-out">
                    {isChanged('bpm') && <Button variant="ghost" size="icon-xs" onClick={() => handleFormChange('bpm', originalFormData.bpm)} title="Reset"><RotateCcw /></Button>}
                  </div>
                </div>
                <Input type="number" value={formData.bpm} onChange={(e) => handleFormChange('bpm', e.target.value)} className={`h-8 text-xs${isChanged('bpm') ? ' border-amber-400/70' : ''}`} placeholder="—" />
              </div>
            </div>

            {/* 2-col: Release | Key */}
            <div className="grid grid-cols-2 gap-2">
              {/* Release */}
              <div className="group flex flex-col gap-0.5">
                <div className="flex items-center justify-between h-4">
                  <span className="text-[9px] uppercase tracking-wider text-muted-foreground font-medium">Release</span>
                  <div className="flex gap-0.5 opacity-0 scale-75 group-hover:opacity-100 group-hover:scale-100 group-focus-within:opacity-100 group-focus-within:scale-100 transition-all duration-150 ease-out">
                    <Button variant="ghost" size="icon-xs" onClick={() => handleCopyFromSc('release_date')} disabled={!selectedScTrack} title="Copy from SC"><activeSource.Icon className="size-3"  /></Button>
                    {isChanged('release_date') && <Button variant="ghost" size="icon-xs" onClick={() => handleFormChange('release_date', originalFormData.release_date)} title="Reset"><RotateCcw /></Button>}
                  </div>
                </div>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      size="sm"
                      className={`h-8 w-full justify-start text-left font-normal text-sm px-2.5 dark:bg-input/30${isChanged('release_date') ? ' border-amber-400/70 dark:border-amber-400/70' : ' dark:border-input'}${!formData.release_date ? ' text-muted-foreground' : ' text-foreground/80'}`}
                    >
                      <CalendarIcon className="mr-1 shrink-0" />
                      {formData.release_date
                        ? format(parse(formData.release_date, 'yyyy-MM-dd', new Date()), 'dd.MM.yyyy')
                        : <span>Pick date</span>}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="start">
                    <Calendar
                      mode="single"
                      selected={formData.release_date && isValid(parse(formData.release_date, 'yyyy-MM-dd', new Date())) ? parse(formData.release_date, 'yyyy-MM-dd', new Date()) : undefined}
                      onSelect={(date) => handleFormChange('release_date', date ? format(date, 'yyyy-MM-dd') : '')}
                      initialFocus
                    />
                  </PopoverContent>
                </Popover>
              </div>

              {/* Key */}
              <div className="group flex flex-col gap-0.5">
                <div className="flex items-center justify-between h-4">
                  <span className="text-[9px] uppercase tracking-wider text-muted-foreground font-medium">Key</span>
                  <div className="flex gap-0.5 opacity-0 scale-75 group-hover:opacity-100 group-hover:scale-100 group-focus-within:opacity-100 group-focus-within:scale-100 transition-all duration-150 ease-out">
                    {isChanged('key') && <Button variant="ghost" size="icon-xs" onClick={() => handleFormChange('key', originalFormData.key)} title="Reset"><RotateCcw /></Button>}
                  </div>
                </div>
                <Input value={formData.key} onChange={(e) => handleFormChange('key', e.target.value)} className={`h-8 text-xs${isChanged('key') ? ' border-amber-400/70' : ''}`} placeholder="—" />
              </div>
            </div>

            {/* Remix section */}
            <div className="pt-3">
              <div className={`relative rounded-lg border transition-colors duration-200 ${isRemix ? 'border-border/50 bg-accent/20' : 'border-border/30'}`}>
                <button
                  onClick={() => setIsRemix(!isRemix)}
                  className={`cursor-pointer absolute -top-2.75 left-3 inline-flex items-center gap-1.5 text-[9px] uppercase tracking-wider font-semibold px-2 py-0.5 rounded-md transition-all duration-150 ${
                    isRemix
                      ? 'bg-card border text-primary shadow-sm'
                      : 'bg-card border border-dashed text-muted-foreground hover:text-foreground'
                  } ${isRemix !== originalIsRemix ? 'border-amber-400/70' : isRemix ? 'border-border/50' : 'border-border/60 hover:border-border'}`}
                >
                  <Wand2 className="size-2.5" />
                  Remix
                </button>
                <div className={`flex flex-col gap-3 px-3 pb-3 pt-5 transition-opacity duration-150 ${isRemix ? 'opacity-100' : 'opacity-40 pointer-events-none'}`}>
                  {/* Row 1: Original Artist | Remixer */}
                  <div className="grid grid-cols-2 gap-3">
                    <div className="group flex flex-col gap-0.5">
                      <div className="flex items-center justify-between h-4">
                        <span className="text-[9px] uppercase tracking-wider text-muted-foreground font-medium">Original Artist</span>
                        <div className="flex gap-0.5 opacity-0 scale-75 group-hover:opacity-100 group-hover:scale-100 group-focus-within:opacity-100 group-focus-within:scale-100 transition-all duration-150 ease-out">
                          <Button variant="ghost" size="icon-xs" onClick={() => { if (!remixData.original_artist) return; const t = cleanArtist(remixData.original_artist); if (t !== remixData.original_artist) setRemixData({...remixData, original_artist: t}); }} title="Clean"><Sparkles /></Button>
                          <Button variant="ghost" size="icon-xs" onClick={() => { if (!remixData.original_artist) return; const t = titelize(remixData.original_artist); if (t !== remixData.original_artist) setRemixData({...remixData, original_artist: t}); }} title="Titelize"><CaseSensitive /></Button>
                          <Popover>
                            <PopoverTrigger asChild>
                              <Button variant="ghost" size="icon-xs" disabled={!selectedScTrack || !scArtistOptions.length}><Users /></Button>
                            </PopoverTrigger>
                            <PopoverContent className="w-48 p-2">
                              <div className="space-y-1">
                                {scArtistOptions.map((artist) => (
                                  <Button key={artist} variant="ghost" size="sm" className="w-full justify-start text-xs" onClick={() => setRemixData({ ...remixData, original_artist: artist })}>{artist}</Button>
                                ))}
                              </div>
                            </PopoverContent>
                          </Popover>
                          {remixData.original_artist !== originalRemixData.original_artist && <Button variant="ghost" size="icon-xs" onClick={() => setRemixData({ ...remixData, original_artist: originalRemixData.original_artist })} title="Reset"><RotateCcw /></Button>}
                        </div>
                      </div>
                      <Input value={remixData.original_artist} onChange={(e) => handleRemixChange('original_artist', e.target.value)} className={`h-8 text-xs${remixData.original_artist !== originalRemixData.original_artist ? ' border-amber-400/70' : ''}`} placeholder="Original artist" />
                    </div>
                    <div className="group flex flex-col gap-0.5">
                      <div className="flex items-center justify-between h-4">
                        <span className="text-[9px] uppercase tracking-wider text-muted-foreground font-medium">Remixer</span>
                        <div className="flex gap-0.5 opacity-0 scale-75 group-hover:opacity-100 group-hover:scale-100 group-focus-within:opacity-100 group-focus-within:scale-100 transition-all duration-150 ease-out">
                          <Button variant="ghost" size="icon-xs" onClick={() => { if (!remixData.remixer) return; const t = cleanArtist(remixData.remixer); if (t !== remixData.remixer) setRemixData({...remixData, remixer: t}); }} title="Clean"><Sparkles /></Button>
                          <Button variant="ghost" size="icon-xs" onClick={() => { if (!remixData.remixer) return; const t = titelize(remixData.remixer); if (t !== remixData.remixer) setRemixData({...remixData, remixer: t}); }} title="Titelize"><CaseSensitive /></Button>
                          <Popover>
                            <PopoverTrigger asChild>
                              <Button variant="ghost" size="icon-xs" disabled={!selectedScTrack || !scArtistOptions.length}><Users /></Button>
                            </PopoverTrigger>
                            <PopoverContent className="w-48 p-2">
                              <div className="space-y-1">
                                {scArtistOptions.map((artist) => (
                                  <Button key={artist} variant="ghost" size="sm" className="w-full justify-start text-xs" onClick={() => setRemixData({ ...remixData, remixer: artist })}>{artist}</Button>
                                ))}
                              </div>
                            </PopoverContent>
                          </Popover>
                          {remixData.remixer !== originalRemixData.remixer && <Button variant="ghost" size="icon-xs" onClick={() => setRemixData({ ...remixData, remixer: originalRemixData.remixer })} title="Reset"><RotateCcw /></Button>}
                        </div>
                      </div>
                      <Input value={remixData.remixer} onChange={(e) => handleRemixChange('remixer', e.target.value)} className={`h-8 text-xs${remixData.remixer !== originalRemixData.remixer ? ' border-amber-400/70' : ''}`} placeholder="Remixer" />
                    </div>
                  </div>
                  {/* Row 2: Mix Type (full width) */}
                  <div className="group flex flex-col gap-0.5">
                    <div className="flex items-center justify-between h-4">
                      <span className="text-[9px] uppercase tracking-wider text-muted-foreground font-medium">Mix Type</span>
                      <div className="flex gap-0.5 opacity-0 scale-75 group-hover:opacity-100 group-hover:scale-100 transition-all duration-150 ease-out">
                        <Popover>
                          <PopoverTrigger asChild>
                            <Button variant="ghost" size="icon-xs" title="Predefined mix types"><ChevronDown /></Button>
                          </PopoverTrigger>
                          <PopoverContent className="w-36 p-1" align="end">
                            <div className="space-y-0.5">
                              {['Remix', 'VIP Mix', 'Extended Mix', 'Radio Edit', 'Club Mix', 'Dub Mix'].map((opt) => (
                                <Button key={opt} variant="ghost" size="sm" className="w-full justify-start text-xs" onClick={() => handleRemixChange('mix_name', opt)}>{opt}</Button>
                              ))}
                            </div>
                          </PopoverContent>
                        </Popover>
                        {remixData.mix_name !== originalRemixData.mix_name && <Button variant="ghost" size="icon-xs" onClick={() => setRemixData({ ...remixData, mix_name: originalRemixData.mix_name })} title="Reset"><RotateCcw /></Button>}
                      </div>
                    </div>
                    <Input value={remixData.mix_name} onChange={(e) => handleRemixChange('mix_name', e.target.value)} className={`h-8 text-xs${remixData.mix_name !== originalRemixData.mix_name ? ' border-amber-400/70' : ''}`} placeholder="Mix type" />
                  </div>
                </div>
              </div>
            </div>

            {/* SC link + search */}
            <div className="pt-3">
              <div className={`relative rounded-lg border transition-colors duration-200 ${scLinkEnabled ? 'border-border/50 bg-accent/40' : 'border-border/30 bg-accent/20'}`}>
                {/* Left chip: SC link toggle */}
                <button
                  onClick={() => setScLinkEnabled(!scLinkEnabled)}
                  className={`cursor-pointer absolute -top-2.75 left-3 inline-flex items-center gap-1.5 text-[9px] uppercase tracking-wider font-semibold px-2 py-0.5 rounded-md transition-all duration-150 ${
                    scLinkEnabled
                      ? 'bg-card border text-primary shadow-sm'
                      : 'bg-card border border-dashed text-muted-foreground hover:text-foreground'
                  } ${scLinkEnabled !== originalScLinkEnabled ? 'border-amber-400/70' : scLinkEnabled ? 'border-border/50' : 'border-border/60 hover:border-border'}`}
                >
                  <activeSource.Icon className="size-2.5" />
                  SoundCloud
                </button>
                {/* Right chip: search toggle */}
                <button
                  onClick={() => setScSidebarOpen(!scSidebarOpen)}
                  className={`cursor-pointer absolute -top-2.75 right-3 inline-flex items-center gap-1 text-[9px] uppercase tracking-wider font-semibold px-2 py-0.5 rounded-md border transition-all duration-150 ${
                    scSidebarOpen
                      ? 'bg-card border-border/50 text-primary shadow-sm'
                      : 'bg-card border-dashed border-border/60 text-muted-foreground hover:text-foreground hover:border-border'
                  }`}
                  title={scSidebarOpen ? 'Close search' : 'Search SoundCloud'}
                >
                  {scSidebarOpen ? <X className="size-2.5" /> : <Search className="size-2.5" />}
                  {scSidebarOpen ? 'Close' : 'Search'}
                </button>

                {/* Link row */}
                <div className={`group flex items-center gap-3 px-3 pt-3 pb-2 transition-opacity duration-150 ${scLinkEnabled ? 'opacity-100' : 'opacity-40 pointer-events-none'}`}>
                  <div className="flex-1 min-w-0">
                    {commentData.soundcloud_id ? (
                      <a
                        href={commentData.soundcloud_permalink || `https://soundcloud.com/tracks/${commentData.soundcloud_id}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={`text-[10px] truncate block font-mono transition-colors hover:text-foreground ${commentData.soundcloud_id !== originalCommentData.soundcloud_id || commentData.soundcloud_permalink !== originalCommentData.soundcloud_permalink ? 'text-amber-400/90' : 'text-muted-foreground'}`}
                      >
                        {commentData.soundcloud_permalink || `ID: ${commentData.soundcloud_id}`}
                      </a>
                    ) : (
                      <span className={`text-[10px] ${commentData.soundcloud_id !== originalCommentData.soundcloud_id || commentData.soundcloud_permalink !== originalCommentData.soundcloud_permalink ? 'text-amber-400/90' : 'text-muted-foreground'}`}>No SoundCloud track linked</span>
                    )}
                  </div>
                  <div className="flex gap-0.5 shrink-0 opacity-0 scale-75 group-hover:opacity-100 group-hover:scale-100 transition-all duration-150 ease-out">
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      onClick={() => {
                        if (!selectedScTrack) return;
                        const meta = activeSource.extractMetadata(selectedScTrack);
                        setCommentData({
                          soundcloud_id: meta.source_id,
                          soundcloud_permalink: meta.source_permalink,
                        });
                        setScLinkEnabled(true);
                      }}
                      disabled={!selectedScTrack}
                      title="Link selected SC track"
                    >
                      <activeSource.Icon className="size-3" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      onClick={() => setCommentData({ soundcloud_id: '', soundcloud_permalink: '' })}
                      disabled={!commentData.soundcloud_id && !commentData.soundcloud_permalink}
                      title="Clear link"
                    >
                      <Trash2 />
                    </Button>
                    {(commentData.soundcloud_id !== originalCommentData.soundcloud_id || commentData.soundcloud_permalink !== originalCommentData.soundcloud_permalink) && (
                      <Button variant="ghost" size="icon-xs" onClick={() => setCommentData(originalCommentData)} title="Reset"><RotateCcw /></Button>
                    )}
                  </div>
                </div>

                {/* Compact track preview (search closed, track selected) */}
                {!scSidebarOpen && selectedScTrack && (
                  <div className="flex items-center gap-2 px-3 pb-2 pt-0 border-t border-border/30">
                    <div className="size-5 shrink-0 rounded overflow-hidden border border-border/30 mt-1.5">
                      {selectedScTrack.artwork_url ? (
                        <img src={selectedScTrack.artwork_url} alt="" className="size-full object-cover" />
                      ) : (
                        <div className="size-full bg-accent/40 flex items-center justify-center">
                          <Image className="size-3 text-muted-foreground/40" />
                        </div>
                      )}
                    </div>
                    <span className="text-xs truncate text-muted-foreground mt-1.5">{selectedScTrack.title}</span>
                  </div>
                )}

                {/* Expanded search UI */}
                {scSidebarOpen && (
                  <div className="border-t border-border/30">
                    <div className={`px-3 py-2.5 ${(selectedScTrack || scResults.length > 0) ? 'border-b border-border/30' : ''}`}>
                      <div className="flex gap-2">
                        <Input
                          value={scQuery}
                          onChange={(e) => setScQuery(e.target.value)}
                          placeholder="Search tracks..."
                          onKeyDown={(e) => e.key === 'Enter' && handleScSearch()}
                          className="text-xs h-8"
                          autoFocus
                        />
                        <Button onClick={handleScSearch} disabled={scSearching || !scQuery.trim()} size="sm" className="h-8 px-2.5 shrink-0">
                          <Search className="size-3.5" />
                        </Button>
                      </div>
                    </div>

                    {selectedScTrack && (
                      <div className="px-3 py-3 border-b border-border/30 space-y-2">
                        <a
                          href={selectedScTrack.permalink_url ?? undefined}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-2.5 group/sclink"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <div className="size-8 shrink-0 rounded overflow-hidden border">
                            {selectedScTrack.artwork_url ? (
                              <img src={selectedScTrack.artwork_url} alt="" className="size-full object-cover" />
                            ) : (
                              <div className="size-full bg-accent/40 flex items-center justify-center">
                                <Image className="size-3 text-muted-foreground/40" />
                              </div>
                            )}
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="text-xs font-medium truncate text-foreground group-hover/sclink:text-primary transition-colors">{selectedScTrack.title}</div>
                            <div className="flex items-center gap-1 text-[10px] text-muted-foreground truncate">
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
                            src={activeSource.getEmbedUrl(selectedScTrack, isDark)!}
                            className="rounded-lg overflow-hidden"
                          />
                        )}
                        <div className="flex gap-1.5">
                          <Button onClick={() => { handleApplyScMetadata(selectedScTrack); setScSidebarOpen(false); }} disabled={!trackInfo} size="sm" className="flex-1 h-7 text-xs">Apply All</Button>
                          <Button onClick={() => setSelectedScTrack(null)} variant="ghost" size="sm" className="h-7 text-xs">Clear</Button>
                        </div>
                      </div>
                    )}

                    {scResults.map((track, i) => (
                      <button
                        key={track.id}
                        onClick={() => handleScTrackSelect(track)}
                        className={`cursor-pointer w-full text-left px-3 py-2 transition-colors relative overflow-hidden ${
                          i === scResults.length - 1 ? 'rounded-b-lg' : ''
                        } ${
                          selectedScTrack?.id === track.id
                            ? 'bg-primary/10 text-foreground'
                            : 'text-muted-foreground hover:text-foreground hover:bg-accent/50'
                        }`}
                      >
                        {selectedScTrack?.id === track.id && (
                          <div className="absolute inset-y-0 left-0 w-0.5 bg-primary rounded-r" />
                        )}
                        <div className="flex items-center gap-2.5">
                          <div className="size-8 shrink-0 rounded overflow-hidden border border-border/30">
                            {track.artwork_url ? (
                              <img src={track.artwork_url} alt="" className="size-full object-cover" loading="lazy" />
                            ) : (
                              <div className="size-full bg-accent/40 flex items-center justify-center">
                                <Image className="size-3 text-muted-foreground/40" />
                              </div>
                            )}
                          </div>
                          <div className="min-w-0">
                            <div className="text-xs font-medium truncate">{track.title}</div>
                            <div className="text-[10px] opacity-60 truncate">{track.username}{track.genre ? ` · ${track.genre}` : ''}</div>
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
          <div className="shrink-0 border-t border-border/50 px-3 py-2.5 flex items-center gap-1">
            {(hasChanges || !activeRuleset?.rules.length) ? (
              <>
                <div
                  className={`size-2 rounded-full shrink-0 ${trackInfo.is_ready ? 'bg-chart-1' : 'bg-amber-400'}`}
                  title={[
                    ...(trackInfo.missing_fields.length ? [`Missing: ${trackInfo.missing_fields.join(', ')}`] : []),
                    ...(trackInfo.issues.length ? [trackInfo.issues.join(' · ')] : []),
                  ].join('\n') || 'Ready'}
                />
                <Button onClick={handleSave} disabled={loading || !hasChanges} size="sm" className="h-7 text-xs px-2.5">Save</Button>
              </>
            ) : (
              <TooltipProvider delayDuration={400} disableHoverableContent>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      onClick={handleFinalize}
                      disabled={!trackInfo.is_ready || !formComplete || loading}
                      size="sm"
                      className="h-7 text-xs px-2.5 bg-emerald-600 hover:bg-emerald-700 text-white font-semibold animate-in fade-in slide-in-from-right-2 duration-200"
                    >Apply Rules</Button>
                  </TooltipTrigger>
                  <TooltipContent side="top" sideOffset={6} showArrow={false} className="p-0 max-w-64 bg-popover text-popover-foreground border">
                    <div className="px-3 py-2 border-b border-border">
                      <p className="text-xs font-medium">{activeRuleset?.name ?? 'Rules'}</p>
                    </div>
                    <div className="py-1.5 flex flex-col gap-0.5 px-1.5">
                      {activeRuleset?.rules.map((rule, i) => {
                        const Icon = RULE_ICONS[rule.type];
                        const folderParam = rule.params.folder as string | undefined;
                        const formatParam = rule.params.format as string | undefined;
                        const detail = rule.type === 'convert'
                          ? formatParam ? formatParam.toUpperCase() : 'preferred'
                          : folderParam ? `${folderParam}/` : '';
                        const isConditional = rule.requires.length > 0;
                        return (
                          <div key={i} className={`flex items-center gap-2 rounded px-1.5 py-1 text-xs ${isConditional ? 'ml-4 border-l-2 border-blue-400/30 pl-2.5' : ''}`}>
                            <StepBadge step={i + 1} type={rule.type} />
                            <Icon className={`size-3.5 shrink-0 ${RULE_ICON_COLORS[rule.type]}`} />
                            <span className="capitalize">{rule.type}</span>
                            {detail && <span className="font-mono text-[10px] opacity-70">{detail}</span>}
                            {isConditional && (
                              <span className="text-[9px] rounded bg-blue-400/20 text-blue-300 px-1 font-medium">
                                if converted
                              </span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
            <Button onClick={handleDelete} disabled={loading} variant="ghost" size="icon-xs" className="text-muted-foreground hover:text-destructive animate-in fade-in slide-in-from-right-2 duration-200"><Trash2 /></Button>
          </div>
        </div>
      )}
    </div>
  );
}
