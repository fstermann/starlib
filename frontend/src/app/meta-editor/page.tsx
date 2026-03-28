'use client';

import { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import { api, ApiError, type FileInfo, type TrackInfo, type TrackInfoUpdateRequest } from '@/lib/api';
import { useQueryState } from 'nuqs';
import { searchParams } from '@/lib/search-params';
import { usePlayer } from '@/lib/player-context';
import { cleanTitle, cleanArtist, titelize, removeParenthesis, parseFilename, parseRemix, removeMix } from '@/lib/string-utils';
import type { SCTrack } from '@/lib/soundcloud';
import { format, parse, isValid } from 'date-fns';
import { toast } from 'sonner';
import { useSoundCloudSearch } from './use-soundcloud-search';
import { parseComment, serializeComment, stripQueryParams, scReleaseDate } from './utils';
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
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import { Checkbox } from '@/components/ui/checkbox';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { CollectionFilterBar } from '@/components/collection-filter-bar';
import { CollectionTable } from '@/components/collection-table';
import {
  Sparkles,
  CaseSensitive,
  Trash2,
  Brackets,
  Cloud,
  Wand2,
  Users,
  Settings2,
  Image,
  Download,
  Eraser,
  ArrowUp,
  XCircle,
  CalendarIcon,
  Search,
  RotateCcw,
  ChevronDown,
  PencilLine,
  Eye,
} from 'lucide-react';

export default function MetaEditorPage() {
  const [folderMode, setFolderMode] = useQueryState('mode', searchParams.mode);
  const [viewMode, setViewMode] = useQueryState('view', searchParams.view);
  const [files, setFiles] = useState<FileInfo[]>([]);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [totalFiles, setTotalFiles] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const fileListRef = useRef<HTMLDivElement>(null);
  const editAbortRef = useRef<AbortController | null>(null);
  const [selectedFile, setSelectedFile] = useState<FileInfo | null>(null);
  const [trackInfo, setTrackInfo] = useState<TrackInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // UI state
  const [scPanelOpen, setScPanelOpen] = useState(true);

  // SoundCloud search (extracted hook — fixes stale closure from useEffect)
  const sc = useSoundCloudSearch(scPanelOpen, setError);
  const { scQuery, setScQuery, scResults, scSearching, scQueryPending, setScQueryPending,
          selectedScTrack, setSelectedScTrack, handleScSearch, handleScTrackSelect } = sc;

  // Remix state
  const [isRemix, setIsRemix] = useState(false);
  const [remixData, setRemixData] = useState({
    original_artist: '',
    remixer: '',
    mix_name: 'Remix',
  });

  // Artwork state
  const [artworkUrl, setArtworkUrl] = useState<string | null>(null);
  // base64-encoded artwork data pending save (from SC or user upload)
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

  // Original values for remix/SC-link change detection
  const [originalIsRemix, setOriginalIsRemix] = useState(false);
  const [originalRemixData, setOriginalRemixData] = useState({ original_artist: '', remixer: '', mix_name: 'Remix' });
  const [originalScLinkEnabled, setOriginalScLinkEnabled] = useState(true);
  const [originalCommentData, setOriginalCommentData] = useState({ soundcloud_id: '', soundcloud_permalink: '' });

  // Auto-action settings
  const [autoActions, setAutoActions] = useState({
    autoCopyArtwork: true,
    autoCopyMetadata: true,
    autoClean: true,
    autoTitelize: false,
    autoRemoveOriginalMix: true,
  });

  // UI state
  const [isClosingEditor, setIsClosingEditor] = useState(false);

  const player = usePlayer();

  const [confirmDialog, setConfirmDialog] = useState<{ open: boolean; message: string; onConfirm: () => void }>({
    open: false,
    message: '',
    onConfirm: () => {},
  });
  const showConfirm = (message: string, onConfirm: () => void) =>
    setConfirmDialog({ open: true, message, onConfirm });

  // Load track into global player when selected file changes
  useEffect(() => {
    if (!selectedFile) return;
    player.load({
      filePath: selectedFile.file_path,
      fileName: selectedFile.file_name,
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedFile?.file_path]);

  // Load files when folder mode changes
  useEffect(() => {
    // Cancel any in-flight edit-mode request from the previous mode
    editAbortRef.current?.abort(new DOMException('Request cancelled', 'AbortError'));
    editAbortRef.current = null;
    loadFiles();
    setSelectedFile(null);
    setTrackInfo(null);
    setFormData({ title: '', artist: '', bpm: '', key: '', genre: '', release_date: '' });
    setCommentData({ soundcloud_id: '', soundcloud_permalink: '' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folderMode]);

  // Infinite scroll: load next page when sentinel becomes visible
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) loadMoreFiles();
      },
      { threshold: 0.1 }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPage, totalPages, loadingMore, loading, folderMode, viewMode]);

  // Scroll selected file into view when it changes in edit mode
  useEffect(() => {
    if (viewMode !== 'edit' || !selectedFile) return;
    const timer = setTimeout(() => {
      const el = fileListRef.current?.querySelector(`[data-file-path="${CSS.escape(selectedFile.file_path)}"]`);
      el?.scrollIntoView({ block: 'center' });
    }, 50);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedFile?.file_path]);

  // Auto-fill empty form fields when a SoundCloud track is selected
  useLayoutEffect(() => {
    // Always clear pending state when selectedScTrack settles so Save/Finalize
    // switches only after the form has been updated (avoids one-frame flicker).
    setScQueryPending(false);

    if (!selectedScTrack || !autoActions.autoCopyMetadata) return;

    const releaseDate = scReleaseDate(selectedScTrack);

    setFormData(prev => ({
      ...prev,
      title: prev.title || selectedScTrack.title || '',
      artist: prev.artist || selectedScTrack.user?.username || '',
      genre: prev.genre || selectedScTrack.genre || '',
      release_date: prev.release_date || releaseDate || '',
    }));

    setCommentData(prev => ({
      soundcloud_id: prev.soundcloud_id || String(selectedScTrack.urn?.split(':').pop() ?? ''),
      soundcloud_permalink: prev.soundcloud_permalink || stripQueryParams(selectedScTrack.permalink_url || '') || '',
    }));
  }, [selectedScTrack, autoActions.autoCopyMetadata]);

  // Show SC artwork in preview when no existing artwork
  useEffect(() => {
    if (!selectedScTrack || !autoActions.autoCopyArtwork || !trackInfo || trackInfo.has_artwork) return;

    const scArtworkUrl = selectedScTrack.artwork_url;
    if (!scArtworkUrl) return;

    const hqUrl = scArtworkUrl.replace('-large', '-t500x500');
    setArtworkUrl(hqUrl);
    // Fetch via backend proxy (avoids CORS) and store as base64
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
    if (trackInfo) {
      const parsed = parseFilename(trackInfo.file_name);
      const newFormData = {
        title: trackInfo.title || parsed.title || '',
        artist: trackInfo.artist || parsed.artist || '',
        bpm: trackInfo.bpm?.toString() || '',
        key: trackInfo.key || '',
        genre: trackInfo.genre || '',
        release_date: trackInfo.release_date || '',
      };
      setFormData(newFormData);
      setOriginalFormData(newFormData);
      const parsedComment = parseComment(trackInfo.comment);
      setCommentData(parsedComment);
      setScLinkEnabled(!!(parsedComment.soundcloud_id || parsedComment.soundcloud_permalink));

      // Set remix data — prefer embedded remixers, then auto-detect from title
      if (trackInfo.remixers && trackInfo.remixers.length > 0) {
        setIsRemix(true);
        setRemixData({
          original_artist: trackInfo.artist || '',
          remixer: trackInfo.remixers[0],
          mix_name: 'Remix',
        });
      } else {
        const titleToCheck = trackInfo.title || parsed.title || '';
        const detected = titleToCheck ? parseRemix(titleToCheck) : null;
        if (detected) {
          setIsRemix(true);
          setRemixData({
            original_artist: trackInfo.artist || parsed.artist || '',
            remixer: detected.remixer,
            mix_name: detected.mixName,
          });
        } else {
          setIsRemix(false);
          setRemixData({ original_artist: '', remixer: '', mix_name: 'Remix' });
        }
      }

      // Capture original remix + SC-link state for change detection
      const initialIsRemix = !!(trackInfo.remixers && trackInfo.remixers.length > 0) || !!(trackInfo.title && parseRemix(trackInfo.title));
      setOriginalIsRemix(initialIsRemix);
      setOriginalRemixData(
        trackInfo.remixers && trackInfo.remixers.length > 0
          ? { original_artist: trackInfo.artist || '', remixer: trackInfo.remixers[0], mix_name: 'Remix' }
          : { original_artist: '', remixer: '', mix_name: 'Remix' }
      );
      const initialScLinkEnabled = !!(parsedComment.soundcloud_id || parsedComment.soundcloud_permalink);
      setOriginalScLinkEnabled(initialScLinkEnabled);
      setOriginalCommentData(parsedComment);

      // Load artwork if available
      if (trackInfo.has_artwork) {
        setPendingArtworkData(null);
        setArtworkUrl(api.getArtworkUrl(trackInfo.file_path));
      } else {
        setArtworkUrl(null);
      }

      // Auto-populate SoundCloud search: use saved permalink URL for exact match, else cleaned filename
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
    }
  }, [trackInfo]);

  const loadFiles = async () => {
    editAbortRef.current?.abort(new DOMException('Request cancelled', 'AbortError'));
    const controller = new AbortController();
    editAbortRef.current = controller;
    try {
      setLoading(true);
      setError(null);
      const result = await api.listFiles(folderMode, 1, 50, controller.signal);
      setFiles(result.items);
      setCurrentPage(result.page);
      setTotalPages(result.pages);
      setTotalFiles(result.total);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404 && err.message === 'Folder does not exist') {
        showConfirm(
          'One or more required folders do not exist yet. Create them now?',
          async () => {
            await api.initializeFolders();
            loadFiles();
          }
        );
      } else {
        setError(err instanceof Error ? err.message : 'Failed to load files');
      }
    } finally {
      setLoading(false);
    }
  };

  const loadMoreFiles = useCallback(async () => {
    if (loadingMore || loading || currentPage >= totalPages) return;
    const controller = new AbortController();
    try {
      setLoadingMore(true);
      const nextPage = currentPage + 1;
      const result = await api.listFiles(folderMode, nextPage, 50, controller.signal);
      setFiles(prev => [...prev, ...result.items]);
      setCurrentPage(result.page);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      console.error('Failed to load more files:', err);
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, loading, currentPage, totalPages, folderMode]);

  const loadTrackInfo = async (file: FileInfo) => {
    try {
      setLoading(true);
      setError(null);
      const info = await api.getTrackInfo(file.file_path);
      setTrackInfo(info);
      setSelectedFile(file);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load track info');
    } finally {
      setLoading(false);
    }
  };

  const handleArtworkUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    if (!event.target.files || event.target.files.length === 0) return;
    const file = event.target.files[0];
    // Show preview
    setArtworkUrl(URL.createObjectURL(file));
    // Read as base64 to include in the next save
    const reader = new FileReader();
    reader.onloadend = () => {
      const b64 = (reader.result as string).split(',')[1];
      setPendingArtworkData(b64);
    };
    reader.readAsDataURL(file);
  };

  const handleRemoveArtwork = () => {
    if (!trackInfo) return;

    // If artwork is only pending (not saved), just clear it locally
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

        // Reload track info
        await loadTrackInfo(selectedFile!);
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

  // Auto-action handlers
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

  // Field-specific copy from SoundCloud
  const handleCopyFromSc = (field: keyof typeof formData) => {
    if (!selectedScTrack) return;

    const releaseDate = scReleaseDate(selectedScTrack);

    const scFieldMap: Record<string, string | undefined> = {
      title: selectedScTrack.title ?? undefined,
      artist: selectedScTrack.user?.username ?? undefined,
      genre: selectedScTrack.genre ?? undefined,
      release_date: releaseDate,
    };

    if (field in scFieldMap) {
      setFormData({ ...formData, [field]: scFieldMap[field] || '' });
    }
  };

  // Derive artist options from the selected SC track (deduplicated)
  const scArtistOptions = selectedScTrack
    ? [...new Set([selectedScTrack.metadata_artist, selectedScTrack.user?.username].filter((x): x is string => !!x))]
    : [];

  // Build title from remix data
  const handleBuildTitleFromRemix = () => {
    if (!isRemix || !remixData.original_artist || !remixData.remixer) return;

    const rawTitle = formData.title.replace(/\(.*?\)/g, '').trim();
    const newTitle = `${remixData.original_artist} - ${rawTitle} (${remixData.remixer} ${remixData.mix_name})`;
    setFormData({ ...formData, title: newTitle });
  };

  // Isolate title (remove artist prefix)
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

      // Serialize structured comment (omit SC data when link is disabled)
      const commentStr = serializeComment(
        scLinkEnabled ? commentData.soundcloud_id : '',
        scLinkEnabled ? commentData.soundcloud_permalink : '',
      );
      if (commentStr) updates.comment = commentStr;

      // Add remix data if enabled
      if (isRemix && remixData.remixer) {
        updates.remixers = [remixData.remixer];
      } else {
        updates.remixers = [];
      }

      // Include pending artwork data (from SC or user upload) if any
      if (pendingArtworkData) {
        updates.artwork_data = pendingArtworkData;
      }

      const result = await api.updateTrackInfo(trackInfo.file_path, updates as TrackInfoUpdateRequest);

      // Refresh file list and reload track info with (possibly renamed) path
      const newFilePath = result.new_file_path ?? trackInfo.file_path;
      await loadFiles();
      const newFileInfo: FileInfo = {
        ...selectedFile!,
        file_path: newFilePath,
        file_name: newFilePath.split('/').pop() ?? selectedFile!.file_name,
      };
      setSelectedFile(newFileInfo);
      await loadTrackInfo(newFileInfo);
      toast.success('Metadata saved successfully');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save metadata');
    } finally {
      setLoading(false);
    }
  };

  const handleFinalize = () => {
    if (!trackInfo) return;

    // Capture before navigating away
    const filePathToFinalize = trackInfo.file_path;
    const trackName = formData.title || selectedFile?.file_name || filePathToFinalize;

    // Determine next file to navigate to
    const currentIndex = files.findIndex(f => f.file_path === selectedFile?.file_path);
    const nextFile = currentIndex !== -1
      ? (files[currentIndex + 1] ?? files[currentIndex - 1] ?? null)
      : null;

    // Optimistically remove from list and navigate immediately
    setFiles(prev => prev.filter(f => f.file_path !== filePathToFinalize));
    if (nextFile) {
      loadTrackInfo(nextFile);
    } else {
      setSelectedFile(null);
      setTrackInfo(null);
      setFormData({ title: '', artist: '', bpm: '', key: '', genre: '', release_date: '' });
      setCommentData({ soundcloud_id: '', soundcloud_permalink: '' });
    }

    // Fire finalization in the background
    const toastId = toast.loading(`Finalizing "${trackName}"…`);
    api.finalizeTrack(filePathToFinalize, { target_format: 'aiff' })
      .then((result) => {
        toast.success(result.message, { id: toastId });
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : 'Failed to finalize track';
        toast.error(message, { id: toastId, duration: Infinity });
        // Re-sync so the failed track reappears in the list
        loadFiles();
      });
  };

  const handleDelete = () => {
    if (!trackInfo) return;

    showConfirm('Are you sure you want to delete this file?', async () => {
      try {
        setLoading(true);
        setError(null);
        await api.deleteFile(trackInfo.file_path);

        // Reload file list
        await loadFiles();
        setSelectedFile(null);
        setTrackInfo(null);
        setFormData({ title: '', artist: '', bpm: '', key: '', genre: '', release_date: '' });
        setCommentData({ soundcloud_id: '', soundcloud_permalink: '' });
        toast.success('File deleted successfully');
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to delete file');
      } finally {
        setLoading(false);
      }
    });
  };

  const handleApplyScMetadata = (track: SCTrack) => {
    const releaseDate = scReleaseDate(track);
    const artist = track.user?.username;

    setFormData(prev => ({
      ...prev,
      ...(track.title ? { title: track.title } : {}),
      ...(artist ? { artist } : {}),
      ...(track.genre ? { genre: track.genre } : {}),
      ...(releaseDate ? { release_date: releaseDate } : {}),
    }));

    setCommentData({
      soundcloud_id: String(track.urn?.split(':').pop() ?? ''),
      soundcloud_permalink: stripQueryParams(track.permalink_url || ''),
    });

    // Show SC artwork in preview if no existing artwork
    if (trackInfo && !trackInfo.has_artwork && track.artwork_url) {
      const hqUrl = track.artwork_url.replace('-large', '-t500x500');
      setArtworkUrl(hqUrl);
      api.proxyImage(hqUrl).then((blob) => {
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
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
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

      {error && (
        <div className="mx-4 mt-2 shrink-0 bg-destructive/10 border border-destructive/20 text-destructive text-xs px-3 py-2 rounded-lg">
          {error}
        </div>
      )}

      {/* Main content */}
      <div className="flex flex-1 min-h-0">
        {/* Center area */}
        <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
          {/* Folder mode tabs + SC panel toggle */}
          <div className="flex items-center justify-between px-4 border-b border-border/50 shrink-0 h-11">
            <div className="flex items-center gap-2">
              {/* Edit / View toggle */}
              <ToggleGroup
                type="single"
                variant="outline"
                value={viewMode}
                onValueChange={(v) => {
                  if (!v) return;
                  const next = v as 'edit' | 'view';
                  setViewMode(next);
                  if (next === 'edit' && player.currentTrack) {
                    // Sync player's active track → edit file selection
                    const match = files.find((f) => f.file_path === player.currentTrack!.filePath);
                    if (match && match.file_path !== selectedFile?.file_path) {
                      loadTrackInfo(match);
                    } else if (!match && player.currentTrack.filePath !== selectedFile?.file_path) {
                      // Track not in loaded pages — load directly
                      const stub: FileInfo = {
                        file_path: player.currentTrack.filePath,
                        file_name: player.currentTrack.fileName,
                        file_size: 0,
                        file_format: '',
                        has_artwork: false,
                      };
                      loadTrackInfo(stub);
                    }
                  } else if (next === 'view' && selectedFile) {
                    // Sync edit selection → player (load without playing)
                    player.load({
                      filePath: selectedFile.file_path,
                      fileName: selectedFile.file_name,
                      title: trackInfo?.title ?? undefined,
                      artist: trackInfo?.artist ?? undefined,
                    });
                  }
                }}
                className="h-7"
              >
                <ToggleGroupItem value="edit" className="h-7 w-7 p-0 cursor-pointer" title="Edit">
                  <PencilLine className="size-3.5" />
                </ToggleGroupItem>
                <ToggleGroupItem value="view" className="h-7 w-7 p-0 cursor-pointer" title="View">
                  <Eye className="size-3.5" />
                </ToggleGroupItem>
              </ToggleGroup>

              <div className="w-px h-5 bg-border/50" />

              {(['prepare', 'collection', 'cleaned'] as const).map((mode) => (
                <button
                  key={mode}
                  onClick={() => setFolderMode(mode)}
                  className={`cursor-pointer px-3 py-1.5 rounded text-[10px] font-medium tracking-widest uppercase transition-colors ${
                    folderMode === mode
                      ? 'text-primary bg-primary/10'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {mode}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2">

              {viewMode === 'edit' && (
                <>
                  <Popover>
                    <PopoverTrigger asChild>
                      <button className="cursor-pointer size-6 flex items-center justify-center rounded-md transition-colors hover:bg-accent/50 text-muted-foreground hover:text-foreground">
                        <Settings2 className="size-3.5" />
                      </button>
                    </PopoverTrigger>
                    <PopoverContent className="w-52" align="end">
                      <div className="space-y-3">
                        <h4 className="text-[10px] font-bold tracking-widest text-muted-foreground uppercase">Auto-Actions</h4>
                        <div className="space-y-2">
                          <div className="flex items-center gap-2">
                            <Checkbox id="auto-artwork" checked={autoActions.autoCopyArtwork} onCheckedChange={(v) => setAutoActions({ ...autoActions, autoCopyArtwork: v as boolean })} />
                            <label htmlFor="auto-artwork" className="text-xs cursor-pointer flex items-center gap-1.5"><Image className="size-3 text-muted-foreground" />Artwork</label>
                          </div>
                          <div className="flex items-center gap-2">
                            <Checkbox id="auto-metadata" checked={autoActions.autoCopyMetadata} onCheckedChange={(v) => setAutoActions({ ...autoActions, autoCopyMetadata: v as boolean })} />
                            <label htmlFor="auto-metadata" className="text-xs cursor-pointer flex items-center gap-1.5"><Download className="size-3 text-muted-foreground" />Metadata</label>
                          </div>
                          <div className="flex items-center gap-2">
                            <Checkbox id="auto-clean" checked={autoActions.autoClean} onCheckedChange={(v) => setAutoActions({ ...autoActions, autoClean: v as boolean })} />
                            <label htmlFor="auto-clean" className="text-xs cursor-pointer flex items-center gap-1.5"><Eraser className="size-3 text-muted-foreground" />Clean</label>
                          </div>
                          <div className="flex items-center gap-2">
                            <Checkbox id="auto-titelize" checked={autoActions.autoTitelize} onCheckedChange={(v) => setAutoActions({ ...autoActions, autoTitelize: v as boolean })} />
                            <label htmlFor="auto-titelize" className="text-xs cursor-pointer flex items-center gap-1.5"><ArrowUp className="size-3 text-muted-foreground" />Titelize</label>
                          </div>
                          <div className="flex items-center gap-2">
                            <Checkbox id="auto-remove-mix" checked={autoActions.autoRemoveOriginalMix} onCheckedChange={(v) => setAutoActions({ ...autoActions, autoRemoveOriginalMix: v as boolean })} />
                            <label htmlFor="auto-remove-mix" className="text-xs cursor-pointer flex items-center gap-1.5"><XCircle className="size-3 text-muted-foreground" />Remove &quot;Original Mix&quot;</label>
                          </div>
                        </div>
                      </div>
                    </PopoverContent>
                  </Popover>
                  <button
                    onClick={() => setScPanelOpen(!scPanelOpen)}
                    title={scPanelOpen ? 'Hide SoundCloud panel' : 'Show SoundCloud panel'}
                    className={`cursor-pointer size-6 flex items-center justify-center rounded-md transition-colors hover:bg-accent/50 ${scPanelOpen ? 'text-primary' : 'text-muted-foreground hover:text-foreground'}`}
                  >
                    <Cloud className="size-4" />
                  </button>
                </>
              )}
            </div>
          </div>

          {/* View mode — filter bar + browse table */}
          {viewMode === 'view' && (
            <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
              <CollectionFilterBar mode={folderMode} />
              <CollectionTable mode={folderMode} scrollToFilePath={player.currentTrack?.filePath} />
            </div>
          )}

          {/* Edit mode — track editor + file list */}
          {viewMode === 'edit' && (<>

          {/* Selected track editor row */}
          {selectedFile && loading && !trackInfo && (
            <div className="px-3 pt-2.5 pb-2 shrink-0">
              <div className="rounded-xl border border-border bg-card shadow-sm p-3">
                <div className="flex items-start gap-2">
                  <div className="flex flex-col gap-0.5 shrink-0 items-center">
                    <Skeleton className="size-4 w-16 mt-4" />
                    <Skeleton className="size-21.5 rounded-lg mt-0.5" />
                  </div>
                  <div className="flex-1 flex flex-col gap-2 mt-4">
                    <div className="flex gap-2">
                      <Skeleton className="h-8 flex-[3]" />
                      <Skeleton className="h-8 flex-[1.2]" />
                      <Skeleton className="h-8 w-16" />
                    </div>
                    <div className="flex gap-2">
                      <Skeleton className="h-8 flex-[3]" />
                      <Skeleton className="h-8 flex-[1.2]" />
                      <Skeleton className="h-8 w-16" />
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
          {trackInfo && (
            <div className={`px-3 pt-2.5 pb-2 shrink-0 ${isClosingEditor ? 'animate-out fade-out slide-out-to-top-4 duration-150 ease-in' : 'animate-in fade-in slide-in-from-top-10 duration-500 ease-out'}`}>
              <div className="rounded-xl border border-border bg-card shadow-sm p-3">
              <div className="flex items-start gap-2">
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
                          if (!selectedScTrack?.artwork_url) return;
                          const hqUrl = selectedScTrack.artwork_url.replace('-large', '-t500x500');
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
                      ><Cloud /></Button>
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

                {/* Two-row field grid */}
                <div className="flex-1 min-w-0 flex flex-col gap-1">
                  {/* Row 1: Title | Genre | BPM */}
                  <div className="flex gap-2 items-start">
                    {/* Title */}
                    <div className="group flex-[3] min-w-0 flex flex-col gap-0.5">
                      <div className="flex items-center justify-between h-4">
                        <span className="text-[9px] uppercase tracking-wider text-muted-foreground font-medium">Title</span>
                        <div className="flex gap-0.5 opacity-0 scale-75 group-hover:opacity-100 group-hover:scale-100 group-focus-within:opacity-100 group-focus-within:scale-100 transition-all duration-150 ease-out">
                          <Button variant="ghost" size="icon-xs" onClick={() => handleCopyFromSc('title')} disabled={!selectedScTrack} title="Copy from SoundCloud"><Cloud /></Button>
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

                    {/* Genre */}
                    <div className="group flex-[1.2] min-w-0 flex flex-col gap-0.5">
                      <div className="flex items-center justify-between h-4">
                        <span className="text-[9px] uppercase tracking-wider text-muted-foreground font-medium">Genre</span>
                        <div className="flex gap-0.5 opacity-0 scale-75 group-hover:opacity-100 group-hover:scale-100 group-focus-within:opacity-100 group-focus-within:scale-100 transition-all duration-150 ease-out">
                          <Button variant="ghost" size="icon-xs" onClick={() => handleCopyFromSc('genre')} disabled={!selectedScTrack} title="Copy from SC"><Cloud /></Button>
                          <Button variant="ghost" size="icon-xs" onClick={() => { if (!formData.genre) return; const t = titelize(formData.genre); if (t !== formData.genre) setFormData({...formData, genre: t}); }} title="Titelize"><CaseSensitive /></Button>
                          {isChanged('genre') && <Button variant="ghost" size="icon-xs" onClick={() => handleFormChange('genre', originalFormData.genre)} title="Reset"><RotateCcw /></Button>}
                        </div>
                      </div>
                      <Input value={formData.genre} onChange={(e) => handleFormChange('genre', e.target.value)} className={`h-8 text-xs${isChanged('genre') ? ' border-amber-400/70' : ''}`} placeholder="—" />
                    </div>

                    {/* BPM */}
                    <div className="group flex flex-col gap-0.5 w-16 shrink-0">
                      <div className="flex items-center justify-between h-4">
                        <span className="text-[9px] uppercase tracking-wider text-muted-foreground font-medium">BPM</span>
                        <div className="flex gap-0.5 opacity-0 scale-75 group-hover:opacity-100 group-hover:scale-100 group-focus-within:opacity-100 group-focus-within:scale-100 transition-all duration-150 ease-out">
                          {isChanged('bpm') && <Button variant="ghost" size="icon-xs" onClick={() => handleFormChange('bpm', originalFormData.bpm)} title="Reset"><RotateCcw /></Button>}
                        </div>
                      </div>
                      <Input type="number" value={formData.bpm} onChange={(e) => handleFormChange('bpm', e.target.value)} className={`h-8 text-xs${isChanged('bpm') ? ' border-amber-400/70' : ''}`} placeholder="—" />
                    </div>
                  </div>

                  {/* Row 2: Artist | Release | Key */}
                  <div className="flex gap-2 items-start">
                    {/* Artist */}
                    <div className="group flex-[3] min-w-0 flex flex-col gap-0.5">
                      <div className="flex items-center justify-between h-4">
                        <span className="text-[9px] uppercase tracking-wider text-muted-foreground font-medium">Artist</span>
                        <div className="flex gap-0.5 opacity-0 scale-75 group-hover:opacity-100 group-hover:scale-100 group-focus-within:opacity-100 group-focus-within:scale-100 transition-all duration-150 ease-out">
                          <Button variant="ghost" size="icon-xs" onClick={() => handleCopyFromSc('artist')} disabled={!selectedScTrack} title="Copy from SoundCloud"><Cloud /></Button>
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

                    {/* Release */}
                    <div className="group flex-[1.2] min-w-0 flex flex-col gap-0.5">
                      <div className="flex items-center justify-between h-4">
                        <span className="text-[9px] uppercase tracking-wider text-muted-foreground font-medium">Release</span>
                        <div className="flex gap-0.5 opacity-0 scale-75 group-hover:opacity-100 group-hover:scale-100 group-focus-within:opacity-100 group-focus-within:scale-100 transition-all duration-150 ease-out">
                          <Button variant="ghost" size="icon-xs" onClick={() => handleCopyFromSc('release_date')} disabled={!selectedScTrack} title="Copy from SC"><Cloud /></Button>
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
                        <PopoverContent className="w-auto p-0" align="end">
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
                    <div className="group flex flex-col gap-0.5 w-16 shrink-0">
                      <div className="flex items-center justify-between h-4">
                        <span className="text-[9px] uppercase tracking-wider text-muted-foreground font-medium">Key</span>
                        <div className="flex gap-0.5 opacity-0 scale-75 group-hover:opacity-100 group-hover:scale-100 group-focus-within:opacity-100 group-focus-within:scale-100 transition-all duration-150 ease-out">
                          {isChanged('key') && <Button variant="ghost" size="icon-xs" onClick={() => handleFormChange('key', originalFormData.key)} title="Reset"><RotateCcw /></Button>}
                        </div>
                      </div>
                      <Input value={formData.key} onChange={(e) => handleFormChange('key', e.target.value)} className={`h-8 text-xs${isChanged('key') ? ' border-amber-400/70' : ''}`} placeholder="—" />
                    </div>
                  </div>
                </div>

              </div>

            <div className="py-3 shrink-0 flex flex-col gap-3">
              <div className="flex gap-2 items-start">

                {/* Remix fields */}
                <div className="flex-1 min-w-0 pt-3">
                  <div className={`relative rounded-lg border transition-colors duration-200 ${isRemix ? 'border-border/50 bg-accent/20' : 'border-border/30'}`}>
                    {/* Toggle button sits on the top border */}
                    <button
                      onClick={() => setIsRemix(!isRemix)}
                      className={`cursor-pointer absolute -top-[11px] left-3 inline-flex items-center gap-1.5 text-[9px] uppercase tracking-wider font-semibold px-2 py-0.5 rounded-md transition-all duration-150 ${
                        isRemix
                          ? 'bg-card border text-primary shadow-sm'
                          : 'bg-card border border-dashed text-muted-foreground hover:text-foreground'
                      } ${isRemix !== originalIsRemix ? 'border-amber-400/70' : isRemix ? 'border-border/50' : 'border-border/60 hover:border-border'}`}
                    >
                      <Wand2 className="size-2.5" />
                      Remix
                    </button>
                    <div className={`grid grid-cols-3 gap-3 px-3 pb-3 pt-5 transition-opacity duration-150 ${isRemix ? 'opacity-100' : 'opacity-40 pointer-events-none'}`}>
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

              </div>

              {/* SC link */}
              <div className="pt-3 flex items-end gap-2">
                <div className={`relative rounded-lg border min-w-0 flex-1 transition-colors duration-200 ${scLinkEnabled ? 'border-border/50 bg-accent/40' : 'border-border/30 bg-accent/20'}`}>
                <button
                  onClick={() => setScLinkEnabled(!scLinkEnabled)}
                  className={`cursor-pointer absolute -top-[11px] left-3 inline-flex items-center gap-1.5 text-[9px] uppercase tracking-wider font-semibold px-2 py-0.5 rounded-md transition-all duration-150 ${
                    scLinkEnabled
                      ? 'bg-card border text-primary shadow-sm'
                      : 'bg-card border border-dashed text-muted-foreground hover:text-foreground'
                  } ${scLinkEnabled !== originalScLinkEnabled ? 'border-amber-400/70' : scLinkEnabled ? 'border-border/50' : 'border-border/60 hover:border-border'}`}
                >
                  <Cloud className="size-2.5" />
                  SoundCloud
                </button>
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
                        setCommentData({
                          soundcloud_id: String(selectedScTrack.urn?.split(':').pop() ?? ''),
                          soundcloud_permalink: stripQueryParams(selectedScTrack.permalink_url || ''),
                        });
                      }}
                      disabled={!selectedScTrack}
                      title="Link selected SC track"
                    >
                      <Cloud />
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
                </div>
                <div className="flex items-center gap-1 pb-2 pl-2 shrink-0">
                  {(hasChanges || folderMode !== 'prepare') ? (
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
                    <Button
                      onClick={handleFinalize}
                      disabled={!trackInfo.is_ready || !formComplete || loading}
                      size="sm"
                      className="h-7 text-xs px-2.5 bg-emerald-600 hover:bg-emerald-700 text-white font-semibold animate-in fade-in slide-in-from-right-2 duration-200"
                    >Finalize</Button>
                  )}
                  <Button onClick={handleDelete} disabled={loading} variant="ghost" size="icon-xs" className="text-muted-foreground hover:text-destructive animate-in fade-in slide-in-from-right-2 duration-200"><Trash2 /></Button>
                </div>
              </div>
              </div>
            </div>
          </div>)}

          {/* File list */}
          <div ref={fileListRef} className="flex-1 overflow-y-auto">
            {loading && !trackInfo && null}
            {!trackInfo && files.length === 0 && !loading && (
              <p className="text-xs text-muted-foreground px-4 py-6 text-center">No files found</p>
            )}
            {files.length > 0 && (
              <p className="text-[10px] text-muted-foreground/50 px-4 py-1.5 font-mono border-b border-border/20">
                {files.length} / {totalFiles} files
              </p>
            )}
            {files.map((file) => (
              <button
                key={file.file_path}
                data-file-path={file.file_path}
                onClick={() => {
                  if (selectedFile?.file_path === file.file_path) {
                    setSelectedFile(null);
                    setIsClosingEditor(true);
                    setTimeout(() => {
                      setTrackInfo(null);
                      setIsClosingEditor(false);
                    }, 150);
                  } else {
                    loadTrackInfo(file);
                  }
                }}
                className={`cursor-pointer w-full text-left px-4 py-2.5 transition-colors relative border-b border-border/20 ${
                  selectedFile?.file_path === file.file_path
                    ? 'bg-primary/10 text-foreground'
                    : 'text-muted-foreground hover:text-foreground hover:bg-accent/50'
                }`}
              >
                {selectedFile?.file_path === file.file_path && (
                  <div className="absolute inset-y-0 left-0 w-0.5 bg-primary rounded-r" />
                )}
                <div className="flex items-center gap-3">
                  <div className="size-8 shrink-0 rounded overflow-hidden border border-border/30">
                    {file.has_artwork ? (
                      <img src={api.getArtworkUrl(file.file_path)} alt="" className="size-full object-cover" loading="lazy" />
                    ) : (
                      <div className="size-full bg-accent/40 flex items-center justify-center">
                        <Image className="size-3 text-muted-foreground/40" />
                      </div>
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-medium truncate">{file.file_name}</div>
                    <div className="text-[10px] opacity-50 font-mono mt-0.5">
                      {(file.file_size / 1024 / 1024).toFixed(1)} MB · {file.file_format.replace('.', '').toUpperCase()}
                    </div>
                  </div>
                </div>
              </button>
            ))}
            {/* Infinite scroll sentinel */}
            {currentPage < totalPages && (
              <div ref={sentinelRef} className="py-3 flex justify-center">
                {loadingMore && (
                  <div className="size-4 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
                )}
              </div>
            )}
          </div>
          </>)}
        </div>

        {/* SoundCloud panel */}
        {viewMode === 'edit' && (
        <div className={`shrink-0 flex flex-col transition-[width] duration-200 ease-in-out overflow-hidden ${scPanelOpen ? 'w-72 border-l border-border/50' : 'w-0'}`}>
          <div className="w-72 flex flex-col flex-1 min-h-0">
            <div className="px-4 py-2.5 border-b border-border/50 flex items-center gap-2">
              <span className="text-[10px] font-bold tracking-widest text-primary uppercase">SoundCloud</span>
            </div>
            <div className="flex flex-col flex-1 min-h-0">
                <div className="px-3 py-2.5 border-b border-border/50">
                  <div className="flex gap-2">
                    <Input
                      value={scQuery}
                      onChange={(e) => setScQuery(e.target.value)}
                      placeholder="Search tracks..."
                      onKeyDown={(e) => e.key === 'Enter' && handleScSearch()}
                      className="text-xs h-8"
                    />
                    <Button onClick={handleScSearch} disabled={scSearching || !scQuery.trim()} size="sm" className="h-8 px-2.5 shrink-0">
                      <Search className="size-3.5" />
                    </Button>
                  </div>
                </div>

                {selectedScTrack && (
                  <div className="px-3 py-3 border-b border-border/50 space-y-2">
                    <iframe
                      width="100%"
                      height="120"
                      scrolling="no"
                      frameBorder="no"
                      allow="autoplay"
                      src={`https://w.soundcloud.com/player/?url=${encodeURIComponent(selectedScTrack.permalink_url ?? '')}&color=%23e05d38&auto_play=false&hide_related=true&show_comments=false&show_user=true&show_reposts=false&show_teaser=false&visual=true`}
                      className="rounded-lg overflow-hidden"
                    />
                    <div className="flex gap-1.5">
                      <Button onClick={() => handleApplyScMetadata(selectedScTrack)} disabled={!trackInfo} size="sm" className="flex-1 h-7 text-xs">Apply All</Button>
                      <Button onClick={() => setSelectedScTrack(null)} variant="ghost" size="sm" className="h-7 text-xs">Clear</Button>
                    </div>
                  </div>
                )}

                <div className="flex-1 overflow-y-auto">
                  {scResults.map((track) => (
                    <button
                      key={track.urn}
                      onClick={() => handleScTrackSelect(track)}
                      className={`cursor-pointer w-full text-left px-3 py-2 transition-colors relative ${
                        selectedScTrack?.urn === track.urn
                          ? 'bg-primary/10 text-foreground'
                          : 'text-muted-foreground hover:text-foreground hover:bg-accent/50'
                      }`}
                    >
                      {selectedScTrack?.urn === track.urn && (
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
                          <div className="text-[10px] opacity-60 truncate">{track.user?.username}{track.genre ? ` · ${track.genre}` : ''}</div>
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
            </div>
          </div>
        </div>
        )}
      </div>
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
    </div>
  );
}
