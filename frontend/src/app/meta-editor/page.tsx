'use client';

import { useState, useEffect, useRef } from 'react';
import { api, type FileInfo, type TrackInfo } from '@/lib/api';
import { cleanTitle, cleanArtist, titelize, removeParenthesis, parseFilename, parseRemix } from '@/lib/string-utils';
import * as soundcloud from '@/lib/soundcloud';
import type { SCTrack } from '@/lib/soundcloud';
import { format, parse, isValid } from 'date-fns';
import { Button } from '@/components/ui/button';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import { Checkbox } from '@/components/ui/checkbox';
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
  ChevronDown,
  ChevronUp,
  Play,
  Pause,
  CalendarIcon,
} from 'lucide-react';

/** Parse the backend's semicolon-delimited comment string into structured fields. */
function parseComment(raw: string | undefined): { soundcloud_id: string; soundcloud_permalink: string } {
  const result: Record<string, string> = {};
  if (raw) {
    for (const pair of raw.split(/;\s*\n?/)) {
      const idx = pair.indexOf('=');
      if (idx > 0) {
        const k = pair.slice(0, idx).trim();
        const v = pair.slice(idx + 1).trim()
          .replace(/\\;/g, ';')
          .replace(/\\=/g, '=')
          .replace(/\\\\/g, '\\');
        result[k] = v;
      }
    }
  }
  return {
    soundcloud_id: result['soundcloud_id'] ?? '',
    soundcloud_permalink: result['soundcloud_permalink'] ?? '',
  };
}

/** Serialize structured comment fields back to the backend's format. */
function serializeComment(scId: string, scPermalink: string): string {
  const escape = (v: string) => v.replace(/\\/g, '\\\\').replace(/=/g, '\\=').replace(/;/g, '\\;');
  const parts = ['version=1.0'];
  if (scId) parts.push(`soundcloud_id=${escape(scId)}`);
  if (scPermalink) parts.push(`soundcloud_permalink=${escape(scPermalink)}`);
  return parts.join('; \n');
}

/** Strip query string and fragment from a URL. */
function stripQueryParams(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url;
  }
}
/**
 * Extract a YYYY-MM-DD date string from a SoundCloud track.
 * Tries release_year/month/day first, then falls back to created_at.
 */
function scReleaseDate(track: SCTrack): string | undefined {
  if (track.release_year && track.release_year > 0) {
    const m = track.release_month && track.release_month > 0 ? track.release_month : 1;
    const d = track.release_day && track.release_day > 0 ? track.release_day : 1;
    return `${track.release_year}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  if (track.created_at) {
    // SC format: "2012/07/08 18:29:40 +0000" or ISO "2012-07-08T18:29:40Z"
    const normalized = track.created_at.replace(/\//g, '-').replace(' ', 'T').replace(' +0000', 'Z');
    const date = new Date(normalized);
    if (!isNaN(date.getTime())) {
      return date.toISOString().slice(0, 10);
    }
  }
  return undefined;
}

/** Format seconds as mm:ss. */
function formatTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export default function MetaEditorPage() {
  const [folderMode, setFolderMode] = useState<string>('prepare');
  const [files, setFiles] = useState<FileInfo[]>([]);
  const [selectedFile, setSelectedFile] = useState<FileInfo | null>(null);
  const [trackInfo, setTrackInfo] = useState<TrackInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // SoundCloud search
  const [scQuery, setScQuery] = useState('');
  const [scResults, setScResults] = useState<SCTrack[]>([]);
  const [scSearching, setScSearching] = useState(false);
  const [selectedScTrack, setSelectedScTrack] = useState<SCTrack | null>(null);

  // Remix state
  const [isRemix, setIsRemix] = useState(false);
  const [remixData, setRemixData] = useState({
    original_artist: '',
    remixer: '',
    mix_name: 'Remix',
  });

  // Artwork state
  const [artworkUrl, setArtworkUrl] = useState<string | null>(null);
  const [artworkUploading, setArtworkUploading] = useState(false);
  // Pending SC artwork URL — shown in preview but not yet saved to file
  const [pendingScArtworkUrl, setPendingScArtworkUrl] = useState<string | null>(null);

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

  // Auto-action settings
  const [autoActions, setAutoActions] = useState({
    autoCopyArtwork: true,
    autoCopyMetadata: true,
    autoClean: true,
    autoTitelize: false,
    autoRemoveOriginalMix: true,
  });

  // UI state
  const [scPanelOpen, setScPanelOpen] = useState(true);
  const [detailOpen, setDetailOpen] = useState(false);

  // Audio player state
  const audioRef = useRef<HTMLAudioElement>(null);
  const [audioPlaying, setAudioPlaying] = useState(false);
  const [audioTime, setAudioTime] = useState(0);
  const [audioDuration, setAudioDuration] = useState(0);

  // Reset audio player when selected file changes
  useEffect(() => {
    setAudioPlaying(false);
    setAudioTime(0);
    setAudioDuration(0);
  }, [selectedFile?.file_path]);

  // Load files when folder mode changes
  useEffect(() => {
    loadFiles();
  }, [folderMode]);

  // Auto-search when query changes
  useEffect(() => {
    if (!scQuery.trim() || !scPanelOpen) {
      setScResults([]);
      setSelectedScTrack(null);
      return;
    }

    const timeoutId = setTimeout(() => {
      handleScSearch();
    }, 500); // Debounce by 500ms

    return () => clearTimeout(timeoutId);
  }, [scQuery, scPanelOpen]);

  // Auto-fill empty form fields when a SoundCloud track is selected
  useEffect(() => {
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
    setPendingScArtworkUrl(hqUrl);
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
      setCommentData(parseComment(trackInfo.comment));

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

      // Load artwork if available
      if (trackInfo.has_artwork) {
        setPendingScArtworkUrl(null);
        loadArtwork(trackInfo.file_path);
      } else {
        setArtworkUrl(null);
      }

      // Auto-populate SoundCloud search with cleaned filename
      if (trackInfo.file_name) {
        const cleaned = trackInfo.file_name
          .replace(/\.(mp3|aiff|wav)$/i, '')
          .replace(/_/g, ' ')
          .replace(/\[.*?\]/g, '')
          .trim();
        setScQuery(cleaned);
      }
    }
  }, [trackInfo]);

  const loadFiles = async () => {
    try {
      setLoading(true);
      setError(null);
      const result = await api.listFiles(folderMode);
      setFiles(result.files);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load files');
    } finally {
      setLoading(false);
    }
  };

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

  const loadArtwork = async (filePath: string) => {
    try {
      const blob = await api.getArtwork(filePath);
      const url = URL.createObjectURL(blob);
      setArtworkUrl(url);
    } catch (err) {
      console.error('Failed to load artwork:', err);
      setArtworkUrl(null);
    }
  };

  const handleArtworkUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    if (!trackInfo || !event.target.files || event.target.files.length === 0) return;

    const file = event.target.files[0];

    try {
      setArtworkUploading(true);
      await api.uploadArtwork(trackInfo.file_path, file);

      // Reload track info to get updated has_artwork status
      await loadTrackInfo(selectedFile!);
      alert('Artwork uploaded successfully');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to upload artwork');
    } finally {
      setArtworkUploading(false);
    }
  };

  const handleRemoveArtwork = async () => {
    if (!trackInfo || !confirm('Remove artwork from this file?')) return;

    // If artwork is only pending (not saved), just clear it locally
    if (pendingScArtworkUrl) {
      setArtworkUrl(null);
      setPendingScArtworkUrl(null);
      return;
    }

    try {
      setLoading(true);
      await api.removeArtwork(trackInfo.file_path);
      setArtworkUrl(null);

      // Reload track info
      await loadTrackInfo(selectedFile!);
      alert('Artwork removed successfully');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove artwork');
    } finally {
      setLoading(false);
    }
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

  const handleFormChange = (field: string, value: string | number) => {
    setFormData(prev => ({ ...prev, [field]: value }));
  };

  const handleSave = async () => {
    if (!trackInfo) return;

    try {
      setLoading(true);
      setError(null);

      const updates: any = {};
      Object.entries(formData).forEach(([key, value]) => {
        if (value !== '') {
          if (key === 'bpm') {
            updates[key] = parseInt(value as string);
          } else {
            updates[key] = value;
          }
        }
      });

      // Serialize structured comment
      const commentStr = serializeComment(commentData.soundcloud_id, commentData.soundcloud_permalink);
      if (commentStr) updates.comment = commentStr;

      // Add remix data if enabled
      if (isRemix && remixData.remixer) {
        updates.remixers = [remixData.remixer];
      } else {
        updates.remixers = [];
      }

      await api.updateTrackInfo(trackInfo.file_path, updates);

      // Upload pending SC artwork if any
      if (pendingScArtworkUrl) {
        try {
          const response = await fetch(pendingScArtworkUrl);
          if (response.ok) {
            const blob = await response.blob();
            const artFile = new File([blob], 'artwork.jpg', { type: blob.type || 'image/jpeg' });
            await api.uploadArtwork(trackInfo.file_path, artFile);
          }
        } catch (err) {
          console.error('Failed to upload pending artwork:', err);
        }
      }

      // Reload track info
      await loadTrackInfo(selectedFile!);
      alert('Metadata saved successfully');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save metadata');
    } finally {
      setLoading(false);
    }
  };

  const handleFinalize = async () => {
    if (!trackInfo) return;

    try {
      setLoading(true);
      setError(null);
      const result = await api.finalizeTrack(trackInfo.file_path, {
        target_format: 'mp3',
        quality: 320,
      });
      alert(result.message);

      // Reload file list
      await loadFiles();
      setSelectedFile(null);
      setTrackInfo(null);
      setFormData({ title: '', artist: '', bpm: '', key: '', genre: '', release_date: '' });
      setCommentData({ soundcloud_id: '', soundcloud_permalink: '' });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to finalize track');
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!trackInfo || !confirm('Are you sure you want to delete this file?')) return;

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
      alert('File deleted successfully');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete file');
    } finally {
      setLoading(false);
    }
  };

  const handleScSearch = async () => {
    if (!scQuery.trim()) return;

    try {
      setScSearching(true);
      setError(null);
      const tracks = await soundcloud.searchTracks(scQuery);
      setScResults(tracks);
      setSelectedScTrack(tracks.length > 0 ? tracks[0] : null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'SoundCloud search failed');
    } finally {
      setScSearching(false);
    }
  };

  const handleScTrackSelect = (track: SCTrack) => {
    setSelectedScTrack(track);
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
      setPendingScArtworkUrl(hqUrl);
    }
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
      {/* Hidden audio element */}
      {selectedFile && (
        <audio
          ref={audioRef}
          key={selectedFile.file_path}
          src={api.getAudioUrl(selectedFile.file_path)}
          onTimeUpdate={() => setAudioTime(audioRef.current?.currentTime ?? 0)}
          onLoadedMetadata={() => setAudioDuration(audioRef.current?.duration ?? 0)}
          onEnded={() => setAudioPlaying(false)}
        />
      )}

      {/* Audio player strip */}
      {selectedFile && (
        <div className="flex items-center gap-3 px-4 h-11 border-b border-border/50 bg-card/80 shrink-0">
          <button
            onClick={() => {
              if (!audioRef.current) return;
              if (audioPlaying) {
                audioRef.current.pause();
                setAudioPlaying(false);
              } else {
                audioRef.current.play();
                setAudioPlaying(true);
              }
            }}
            className="size-7 rounded-full bg-primary/10 hover:bg-primary/20 text-primary flex items-center justify-center shrink-0 transition-colors"
          >
            {audioPlaying ? <Pause className="size-3" /> : <Play className="size-3 ml-0.5" />}
          </button>
          <span className="text-xs text-muted-foreground font-mono truncate min-w-0 flex-1">{selectedFile.file_name}</span>
          <input
            type="range"
            min={0}
            max={audioDuration || 1}
            step={0.1}
            value={audioTime}
            onChange={(e) => {
              const t = parseFloat(e.target.value);
              setAudioTime(t);
              if (audioRef.current) audioRef.current.currentTime = t;
            }}
            className="w-36 accent-primary shrink-0"
          />
          <span className="text-[10px] font-mono text-muted-foreground shrink-0 w-20 text-right">
            {formatTime(audioTime)} / {formatTime(audioDuration)}
          </span>
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
          <div className="flex items-center justify-between px-4 border-b border-border/50 shrink-0 h-9">
            <div className="flex items-center gap-0.5">
              {(['prepare', 'collection', 'cleaned'] as const).map((mode) => (
                <button
                  key={mode}
                  onClick={() => setFolderMode(mode)}
                  className={`px-3 py-1.5 rounded text-[10px] font-medium tracking-widest uppercase transition-colors ${
                    folderMode === mode
                      ? 'text-primary bg-primary/10'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {mode}
                </button>
              ))}
            </div>
            <button
              onClick={() => setScPanelOpen(!scPanelOpen)}
              title={scPanelOpen ? 'Hide SoundCloud panel' : 'Show SoundCloud panel'}
              className={`cursor-pointer size-6 flex items-center justify-center rounded-md transition-colors hover:bg-accent/50 ${scPanelOpen ? 'text-primary' : 'text-muted-foreground hover:text-foreground'}`}
            >
              <img src="/soundcloud-dark.png" alt="SoundCloud" className="size-6 dark:hidden" />
              <img src="/soundcloud-light.png" alt="SoundCloud" className="size-6 hidden dark:block" />
            </button>
          </div>

          {/* Selected track editor row */}
          {trackInfo && (
            <div className="px-3 py-2.5 border-b border-border/50 bg-card/40 shrink-0">
              <div className="flex items-end gap-2">
                {/* Artwork thumbnail */}
                <div
                  className={`group relative size-12 shrink-0 rounded-lg overflow-hidden border cursor-pointer ${pendingScArtworkUrl ? 'border-amber-400/70' : 'border-border/50'}`}
                  onClick={() => {
                    const input = document.createElement('input');
                    input.type = 'file';
                    input.accept = 'image/*';
                    input.onchange = handleArtworkUpload as any;
                    input.click();
                  }}
                >
                  {artworkUrl ? (
                    <>
                      <img src={artworkUrl} alt="Artwork" className="size-full object-cover" />
                      <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                        <Image className="size-3 text-white" />
                      </div>
                    </>
                  ) : (
                    <div className="size-full bg-accent/50 flex flex-col items-center justify-center gap-0.5 hover:bg-accent transition-colors">
                      <Image className="size-3 text-muted-foreground" />
                      <span className="text-[8px] text-muted-foreground">N/A</span>
                    </div>
                  )}
                </div>

                {/* Title */}
                <div className="group flex-[3] min-w-0 flex flex-col gap-0.5">
                  <div className="flex items-center justify-between h-4">
                    <span className="text-[9px] uppercase tracking-wider text-muted-foreground font-medium">Title</span>
                    <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
                      <Button variant="ghost" size="icon-xs" onClick={() => handleCopyFromSc('title')} disabled={!selectedScTrack} title="Copy from SoundCloud"><Cloud /></Button>
                      <Button variant="ghost" size="icon-xs" onClick={handleCleanTitle} title="Clean"><Sparkles /></Button>
                      <Button variant="ghost" size="icon-xs" onClick={() => { if (!formData.title) return; const t = titelize(formData.title); if (t !== formData.title) setFormData({...formData, title: t}); }} title="Titelize"><CaseSensitive /></Button>
                      <Button variant="ghost" size="icon-xs" onClick={handleBuildTitleFromRemix} disabled={!isRemix} title="Build from remix"><Wand2 /></Button>
                      <Button variant="ghost" size="icon-xs" onClick={handleRemoveParenthesis} title="Remove brackets"><Brackets /></Button>
                      <Button variant="ghost" size="icon-xs" onClick={handleIsolateTitle} title="Isolate"><Trash2 /></Button>
                    </div>
                  </div>
                  <Input value={formData.title} onChange={(e) => handleFormChange('title', e.target.value)} className={`h-8 text-xs font-medium${isChanged('title') ? ' border-amber-400/70' : ''}`} placeholder="Title" />
                </div>

                {/* Artist */}
                <div className="group flex-[2] min-w-0 flex flex-col gap-0.5">
                  <div className="flex items-center justify-between h-4">
                    <span className="text-[9px] uppercase tracking-wider text-muted-foreground font-medium">Artist</span>
                    <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
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
                    </div>
                  </div>
                  <Input value={formData.artist} onChange={(e) => handleFormChange('artist', e.target.value)} className={`h-8 text-xs${isChanged('artist') ? ' border-amber-400/70' : ''}`} placeholder="Artist" />
                </div>

                {/* Genre */}
                <div className="group flex-[1.2] min-w-0 flex flex-col gap-0.5">
                  <div className="flex items-center justify-between h-4">
                    <span className="text-[9px] uppercase tracking-wider text-muted-foreground font-medium">Genre</span>
                    <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
                      <Button variant="ghost" size="icon-xs" onClick={() => handleCopyFromSc('genre')} disabled={!selectedScTrack} title="Copy from SC"><Cloud /></Button>
                      <Button variant="ghost" size="icon-xs" onClick={() => { if (!formData.genre) return; const t = titelize(formData.genre); if (t !== formData.genre) setFormData({...formData, genre: t}); }} title="Titelize"><CaseSensitive /></Button>
                    </div>
                  </div>
                  <Input value={formData.genre} onChange={(e) => handleFormChange('genre', e.target.value)} className={`h-8 text-xs${isChanged('genre') ? ' border-amber-400/70' : ''}`} placeholder="—" />
                </div>

                {/* Release */}
                <div className="group w-32 shrink-0 flex flex-col gap-0.5">
                  <div className="flex items-center justify-between h-4">
                    <span className="text-[9px] uppercase tracking-wider text-muted-foreground font-medium">Release</span>
                    <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
                      <Button variant="ghost" size="icon-xs" onClick={() => handleCopyFromSc('release_date')} disabled={!selectedScTrack} title="Copy from SC"><Cloud /></Button>
                    </div>
                  </div>
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button
                        variant="outline"
                        size="sm"
                        className={`h-8 w-full justify-start text-left font-normal text-sm px-2.5 dark:bg-input/30${isChanged('release_date') ? ' border-amber-400/70 dark:border-amber-400/70' : ' dark:border-input'}${!formData.release_date ? ' text-muted-foreground' : ''}`}
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

                {/* Action buttons */}
                <div className="flex items-center gap-1 shrink-0 pb-0.5">
                  <div
                    className={`size-2 rounded-full shrink-0 ${trackInfo.is_ready ? 'bg-chart-1' : 'bg-chart-2'}`}
                    title={trackInfo.is_ready ? 'Ready' : trackInfo.missing_fields.join(', ')}
                  />
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button variant="ghost" size="icon-xs" className="text-muted-foreground"><Settings2 /></Button>
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
                  <Button onClick={handleSave} disabled={loading} size="sm" className="h-7 text-xs px-2.5">Save</Button>
                  <Button onClick={handleFinalize} disabled={!trackInfo.is_ready || loading} variant="secondary" size="sm" className="h-7 text-xs px-2.5">Finalize</Button>
                  <Button onClick={handleDelete} disabled={loading} variant="ghost" size="icon-xs" className="text-muted-foreground hover:text-destructive"><Trash2 /></Button>
                  <Button variant="ghost" size="icon-xs" onClick={() => setDetailOpen(!detailOpen)} className="text-muted-foreground ml-0.5">
                    {detailOpen ? <ChevronUp /> : <ChevronDown />}
                  </Button>
                </div>
              </div>
            </div>
          )}

          {/* Detail section (collapsible) */}
          {trackInfo && detailOpen && (
            <div className="px-4 py-3 border-b border-border/50 space-y-3 bg-accent/20 shrink-0">
              {/* SC link */}
              <div className="flex items-center gap-3 px-3 py-2 rounded-lg bg-accent/40 border border-border/40">
                <Cloud className="size-3.5 text-primary shrink-0" />
                <div className="flex-1 min-w-0">
                  {commentData.soundcloud_id ? (
                    <a
                      href={commentData.soundcloud_permalink || `https://soundcloud.com/tracks/${commentData.soundcloud_id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[10px] text-muted-foreground hover:text-foreground truncate block font-mono transition-colors"
                    >
                      {commentData.soundcloud_permalink || `ID: ${commentData.soundcloud_id}`}
                    </a>
                  ) : (
                    <span className="text-[10px] text-muted-foreground">No SoundCloud track linked</span>
                  )}
                </div>
                <div className="flex gap-1 shrink-0">
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
                    <Download />
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
                </div>
              </div>

              {/* Artwork management */}
              {artworkUrl && (
                <div className="flex items-center gap-3">
                  <img src={artworkUrl} alt="Artwork" className="size-10 rounded-md object-cover border border-border/50" />
                  <div className="flex gap-1.5">
                    <Button
                      variant="outline"
                      size="xs"
                      onClick={() => {
                        const input = document.createElement('input');
                        input.type = 'file';
                        input.accept = 'image/*';
                        input.onchange = handleArtworkUpload as any;
                        input.click();
                      }}
                      disabled={artworkUploading}
                    >
                      {artworkUploading ? 'Uploading...' : 'Replace artwork'}
                    </Button>
                    <Button variant="outline" size="xs" onClick={handleRemoveArtwork} disabled={loading} className="text-destructive hover:text-destructive">
                      Remove
                    </Button>
                  </div>
                </div>
              )}

              {/* Remix + BPM/Key */}
              <div className="flex gap-3 items-start">
                {/* Remix group */}
                <div className={`flex-1 min-w-0 rounded-md border p-2.5 flex gap-3 items-start transition-colors ${
                  isRemix ? 'border-border/50 bg-accent/20' : 'border-transparent'
                }`}>
                  <button
                    onClick={() => setIsRemix(!isRemix)}
                    className={`shrink-0 inline-flex items-center gap-1.5 text-[9px] uppercase tracking-wider font-semibold px-2 py-1 rounded transition-colors mt-4 ${
                      isRemix
                        ? 'bg-primary/15 text-primary border border-primary/25'
                        : 'text-muted-foreground hover:text-foreground border border-dashed border-border/60 hover:border-border'
                    }`}
                  >
                    <Wand2 className="size-2.5" />
                    Remix
                  </button>
                  <div className={`flex-1 min-w-0 grid grid-cols-3 gap-3 ${!isRemix ? 'invisible pointer-events-none' : ''}`}>
                      <div className="group flex flex-col gap-0.5">
                        <div className="flex items-center justify-between h-4">
                          <span className="text-[9px] uppercase tracking-wider text-muted-foreground font-medium">Original Artist</span>
                          <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
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
                          </div>
                        </div>
                        <Input value={remixData.original_artist} onChange={(e) => handleRemixChange('original_artist', e.target.value)} className="h-8 text-xs" placeholder="Original artist" />
                      </div>
                      <div className="group flex flex-col gap-0.5">
                        <div className="flex items-center justify-between h-4">
                          <span className="text-[9px] uppercase tracking-wider text-muted-foreground font-medium">Remixer</span>
                          <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
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
                          </div>
                        </div>
                        <Input value={remixData.remixer} onChange={(e) => handleRemixChange('remixer', e.target.value)} className="h-8 text-xs" placeholder="Remixer" />
                      </div>
                      <div className="group flex flex-col gap-0.5">
                        <div className="flex items-center justify-between h-4">
                          <span className="text-[9px] uppercase tracking-wider text-muted-foreground font-medium">Mix Type</span>
                          <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
                            <Button variant="ghost" size="icon-xs" onClick={() => { if (!remixData.mix_name) return; const t = titelize(remixData.mix_name); if (t !== remixData.mix_name) setRemixData({...remixData, mix_name: t}); }} title="Titelize"><CaseSensitive /></Button>
                          </div>
                        </div>
                        <Select value={remixData.mix_name} onValueChange={(value) => handleRemixChange('mix_name', value)}>
                          <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="Remix">Remix</SelectItem>
                            <SelectItem value="VIP Mix">VIP Mix</SelectItem>
                            <SelectItem value="Extended Mix">Extended Mix</SelectItem>
                            <SelectItem value="Radio Edit">Radio Edit</SelectItem>
                            <SelectItem value="Club Mix">Club Mix</SelectItem>
                            <SelectItem value="Dub Mix">Dub Mix</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                  </div>
                </div>

                {/* BPM & Key */}
                <div className="flex gap-2 shrink-0">
                  <div className="flex flex-col gap-0.5 w-16">
                    <span className="text-[9px] uppercase tracking-wider text-muted-foreground font-medium h-4 flex items-center">BPM</span>
                    <Input type="number" value={formData.bpm} onChange={(e) => handleFormChange('bpm', e.target.value)} className={`h-8 text-xs${isChanged('bpm') ? ' border-amber-400/70' : ''}`} placeholder="—" />
                  </div>
                  <div className="flex flex-col gap-0.5 w-16">
                    <span className="text-[9px] uppercase tracking-wider text-muted-foreground font-medium h-4 flex items-center">Key</span>
                    <Input value={formData.key} onChange={(e) => handleFormChange('key', e.target.value)} className={`h-8 text-xs${isChanged('key') ? ' border-amber-400/70' : ''}`} placeholder="—" />
                  </div>
                </div>
              </div>

              {/* Issues */}
              {trackInfo.issues.length > 0 && (
                <div className="flex items-center gap-2 text-[10px] text-chart-2 font-mono">
                  <div className="size-1.5 rounded-full bg-chart-2 shrink-0" />
                  {trackInfo.issues.join(' · ')}
                </div>
              )}
            </div>
          )}

          {/* File list */}
          <div className="flex-1 overflow-y-auto">
            {loading && !trackInfo && (
              <p className="text-xs text-muted-foreground px-4 py-3">Loading...</p>
            )}
            {!trackInfo && files.length === 0 && !loading && (
              <p className="text-xs text-muted-foreground px-4 py-6 text-center">No files found</p>
            )}
            {files.map((file) => (
              <button
                key={file.file_path}
                onClick={() => loadTrackInfo(file)}
                className={`w-full text-left px-4 py-2.5 transition-colors relative border-b border-border/20 ${
                  selectedFile?.file_path === file.file_path
                    ? 'bg-primary/10 text-foreground'
                    : 'text-muted-foreground hover:text-foreground hover:bg-accent/50'
                }`}
              >
                {selectedFile?.file_path === file.file_path && (
                  <div className="absolute inset-y-0 left-0 w-0.5 bg-primary rounded-r" />
                )}
                <div className="flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-medium truncate">{file.file_name}</div>
                    <div className="text-[10px] opacity-50 font-mono mt-0.5">
                      {(file.file_size / 1024 / 1024).toFixed(1)} MB · {file.file_format.replace('.', '').toUpperCase()}
                    </div>
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* SoundCloud panel */}
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
                    <Button onClick={handleScSearch} disabled={scSearching || !scQuery.trim()} size="sm" className="h-8 px-3 text-xs shrink-0">
                      {scSearching ? '...' : 'Go'}
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
                      className={`w-full text-left px-4 py-2.5 transition-colors relative ${
                        selectedScTrack?.urn === track.urn
                          ? 'bg-primary/10 text-foreground'
                          : 'text-muted-foreground hover:text-foreground hover:bg-accent/50'
                      }`}
                    >
                      {selectedScTrack?.urn === track.urn && (
                        <div className="absolute inset-y-0 left-0 w-0.5 bg-primary rounded-r" />
                      )}
                      <div className="text-xs font-medium truncate">{track.title}</div>
                      <div className="text-[10px] opacity-60 truncate">{track.user?.username}{track.genre ? ` · ${track.genre}` : ''}</div>
                    </button>
                  ))}
                </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
