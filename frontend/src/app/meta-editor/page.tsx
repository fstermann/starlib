'use client';

import { useState, useEffect } from 'react';
import { api, type FileInfo, type TrackInfo } from '@/lib/api';
import { cleanTitle, cleanArtist, titelize, removeParenthesis, parseFilename, parseRemix } from '@/lib/string-utils';
import * as soundcloud from '@/lib/soundcloud';
import type { SCTrack } from '@/lib/soundcloud';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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

export default function MetaEditorPage() {
  const [folderMode, setFolderMode] = useState<string>('prepare');
  const [files, setFiles] = useState<FileInfo[]>([]);
  const [selectedFile, setSelectedFile] = useState<FileInfo | null>(null);
  const [trackInfo, setTrackInfo] = useState<TrackInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // SoundCloud search
  const [scSearchEnabled, setScSearchEnabled] = useState(true);
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

  // Metadata form state
  const [formData, setFormData] = useState({
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

  // Load files when folder mode changes
  useEffect(() => {
    loadFiles();
  }, [folderMode]);

  // Auto-search when query changes
  useEffect(() => {
    if (!scQuery.trim() || !scSearchEnabled) {
      setScResults([]);
      setSelectedScTrack(null);
      return;
    }

    const timeoutId = setTimeout(() => {
      handleScSearch();
    }, 500); // Debounce by 500ms

    return () => clearTimeout(timeoutId);
  }, [scQuery, scSearchEnabled]);

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

  // Update form when track info loads
  useEffect(() => {
    if (trackInfo) {
      const parsed = parseFilename(trackInfo.file_name);
      setFormData({
        title: trackInfo.title || parsed.title || '',
        artist: trackInfo.artist || parsed.artist || '',
        bpm: trackInfo.bpm?.toString() || '',
        key: trackInfo.key || '',
        genre: trackInfo.genre || '',
        release_date: trackInfo.release_date || '',
      });
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
  };

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">Meta Editor</h1>
        {trackInfo && (
          <div className="flex gap-2">
            <Button
              onClick={handleSave}
              disabled={loading}
              variant="default"
            >
              Save
            </Button>
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" size="icon">
                  <Settings2 className="h-4 w-4" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-64" align="end">
                <div className="space-y-4">
                  <div>
                    <h4 className="font-medium text-sm mb-3">Auto-Actions</h4>
                    <div className="space-y-3">
                      <div className="flex items-center space-x-2">
                        <Checkbox
                          id="auto-artwork"
                          checked={autoActions.autoCopyArtwork}
                          onCheckedChange={(checked) =>
                            setAutoActions({ ...autoActions, autoCopyArtwork: checked as boolean })
                          }
                        />
                        <label
                          htmlFor="auto-artwork"
                          className="text-sm cursor-pointer flex items-center gap-1.5"
                        >
                          <Image className="h-3.5 w-3.5" />
                          Artwork
                        </label>
                      </div>
                      <div className="flex items-center space-x-2">
                        <Checkbox
                          id="auto-metadata"
                          checked={autoActions.autoCopyMetadata}
                          onCheckedChange={(checked) =>
                            setAutoActions({ ...autoActions, autoCopyMetadata: checked as boolean })
                          }
                        />
                        <label
                          htmlFor="auto-metadata"
                          className="text-sm cursor-pointer flex items-center gap-1.5"
                        >
                          <Download className="h-3.5 w-3.5" />
                          Metadata
                        </label>
                      </div>
                      <div className="flex items-center space-x-2">
                        <Checkbox
                          id="auto-clean"
                          checked={autoActions.autoClean}
                          onCheckedChange={(checked) =>
                            setAutoActions({ ...autoActions, autoClean: checked as boolean })
                          }
                        />
                        <label
                          htmlFor="auto-clean"
                          className="text-sm cursor-pointer flex items-center gap-1.5"
                        >
                          <Eraser className="h-3.5 w-3.5" />
                          Clean
                        </label>
                      </div>
                      <div className="flex items-center space-x-2">
                        <Checkbox
                          id="auto-titelize"
                          checked={autoActions.autoTitelize}
                          onCheckedChange={(checked) =>
                            setAutoActions({ ...autoActions, autoTitelize: checked as boolean })
                          }
                        />
                        <label
                          htmlFor="auto-titelize"
                          className="text-sm cursor-pointer flex items-center gap-1.5"
                        >
                          <ArrowUp className="h-3.5 w-3.5" />
                          Titelize
                        </label>
                      </div>
                      <div className="flex items-center space-x-2">
                        <Checkbox
                          id="auto-remove-mix"
                          checked={autoActions.autoRemoveOriginalMix}
                          onCheckedChange={(checked) =>
                            setAutoActions({ ...autoActions, autoRemoveOriginalMix: checked as boolean })
                          }
                        />
                        <label
                          htmlFor="auto-remove-mix"
                          className="text-sm cursor-pointer flex items-center gap-1.5"
                        >
                          <XCircle className="h-3.5 w-3.5" />
                          Remove "Original Mix"
                        </label>
                      </div>
                    </div>
                  </div>
                </div>
              </PopoverContent>
            </Popover>
            <Button
              onClick={handleFinalize}
              disabled={!trackInfo.is_ready || loading}
              variant="default"
            >
              Finalize
            </Button>
            <Button
              onClick={handleDelete}
              disabled={loading}
              variant="destructive"
            >
              Delete
            </Button>
          </div>
        )}
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-800 px-4 py-3 rounded">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
        {/* File List */}
        <Card className="lg:col-span-1">
          <CardHeader>
            <CardTitle>Files</CardTitle>
            <Field>
              <FieldLabel>Folder</FieldLabel>
              <Select value={folderMode} onValueChange={setFolderMode}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="prepare">Prepare</SelectItem>
                  <SelectItem value="collection">Collection</SelectItem>
                  <SelectItem value="cleaned">Cleaned</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </CardHeader>
          <CardContent>
            {loading && !trackInfo && <p className="text-sm text-muted-foreground">Loading...</p>}
            <div className="space-y-2 max-h-[600px] overflow-y-auto">
              {files.map((file) => (
                <button
                  key={file.file_path}
                  onClick={() => loadTrackInfo(file)}
                  className={`w-full text-left px-3 py-2 rounded hover:bg-accent transition-colors ${selectedFile?.file_path === file.file_path ? 'bg-accent' : ''
                    }`}
                >
                  <div className="text-sm font-medium truncate">{file.file_name}</div>
                  <div className="text-xs text-muted-foreground">
                    {(file.file_size / 1024 / 1024).toFixed(1)} MB
                  </div>
                </button>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Metadata Editor */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>
              {trackInfo ? trackInfo.file_name : 'Select a file'}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {!trackInfo ? (
              <p className="text-muted-foreground">
                Select a file from the list to edit its metadata
              </p>
            ) : (
              <div className="space-y-4">
                <Field>
                  <div className="flex items-center justify-between mb-2">
                    <FieldLabel>Title</FieldLabel>
                    <div className="flex gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6"
                        onClick={() => handleCopyFromSc('title')}
                        disabled={!selectedScTrack}
                        title="Copy from SoundCloud"
                      >
                        <Cloud className="h-3 w-3" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6"
                        onClick={handleCleanTitle}
                        title="Clean title"
                      >
                        <Sparkles className="h-3 w-3" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6"
                        onClick={async () => {
                          if (!formData.title) return;
                          const transformed = titelize(formData.title);
                          if (transformed !== formData.title) setFormData({ ...formData, title: transformed });
                        }}
                        title="Titelize"
                      >
                        <CaseSensitive className="h-3 w-3" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6"
                        onClick={handleBuildTitleFromRemix}
                        disabled={!isRemix}
                        title="Build from remix data"
                      >
                        <Wand2 className="h-3 w-3" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6"
                        onClick={handleRemoveParenthesis}
                        title="Remove brackets"
                      >
                        <Brackets className="h-3 w-3" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6"
                        onClick={handleIsolateTitle}
                        title="Isolate title"
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  </div>
                  <Input
                    value={formData.title}
                    onChange={(e) => handleFormChange('title', e.target.value)}
                  />
                </Field>

                <Field>
                  <div className="flex items-center justify-between mb-2">
                    <FieldLabel>Artist</FieldLabel>
                    <div className="flex gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6"
                        onClick={() => handleCopyFromSc('artist')}
                        disabled={!selectedScTrack}
                        title="Copy from SoundCloud"
                      >
                        <Cloud className="h-3 w-3" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6"
                        onClick={handleCleanArtist}
                        title="Clean artist"
                      >
                        <Sparkles className="h-3 w-3" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6"
                        onClick={async () => {
                          if (!formData.artist) return;
                          const transformed = titelize(formData.artist);
                          if (transformed !== formData.artist) setFormData({ ...formData, artist: transformed });
                        }}
                        title="Titelize"
                      >
                        <CaseSensitive className="h-3 w-3" />
                      </Button>
                      <Popover>
                        <PopoverTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6"
                            disabled={!selectedScTrack || !scArtistOptions.length}
                            title="Artist options"
                          >
                            <Users className="h-3 w-3" />
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent className="w-48 p-2">
                          <div className="space-y-1">
                            {scArtistOptions.map((artist) => (
                              <Button
                                key={artist}
                                variant="ghost"
                                size="sm"
                                className="w-full justify-start"
                                onClick={() => setFormData({ ...formData, artist })}
                              >
                                {artist}
                              </Button>
                            ))}
                          </div>
                        </PopoverContent>
                      </Popover>
                    </div>
                  </div>
                  <Input
                    value={formData.artist}
                    onChange={(e) => handleFormChange('artist', e.target.value)}
                  />
                </Field>

                <div className="grid grid-cols-2 gap-4">
                  <Field>
                    <FieldLabel>BPM</FieldLabel>
                    <Input
                      type="number"
                      value={formData.bpm}
                      onChange={(e) => handleFormChange('bpm', e.target.value)}
                    />
                  </Field>

                  <Field>
                    <FieldLabel>Key</FieldLabel>
                    <Input
                      value={formData.key}
                      onChange={(e) => handleFormChange('key', e.target.value)}
                    />
                  </Field>
                </div>

                <Field>
                  <div className="flex items-center justify-between mb-2">
                    <FieldLabel>Genre</FieldLabel>
                    <div className="flex gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6"
                        onClick={() => handleCopyFromSc('genre')}
                        disabled={!selectedScTrack}
                        title="Copy from SoundCloud"
                      >
                        <Cloud className="h-3 w-3" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6"
                        onClick={async () => {
                          if (!formData.genre) return;
                          const transformed = titelize(formData.genre);
                          if (transformed !== formData.genre) setFormData({ ...formData, genre: transformed });
                        }}
                        title="Titelize"
                      >
                        <CaseSensitive className="h-3 w-3" />
                      </Button>
                    </div>
                  </div>
                  <Input
                    value={formData.genre}
                    onChange={(e) => handleFormChange('genre', e.target.value)}
                  />
                </Field>

                <Field>
                  <div className="flex items-center justify-between mb-2">
                    <FieldLabel>Release Date</FieldLabel>
                    <div className="flex gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6"
                        onClick={() => handleCopyFromSc('release_date')}
                        disabled={!selectedScTrack}
                        title="Copy from SoundCloud"
                      >
                        <Cloud className="h-3 w-3" />
                      </Button>
                    </div>
                  </div>
                  <Input
                    type="date"
                    value={formData.release_date}
                    onChange={(e) => handleFormChange('release_date', e.target.value)}
                  />
                </Field>

                <Field>
                  <div className="flex items-center justify-between mb-2">
                    <FieldLabel>SoundCloud Track</FieldLabel>
                    <div className="flex gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6"
                        onClick={() => {
                          if (!selectedScTrack) return;
                          setCommentData({
                            soundcloud_id: String(selectedScTrack.urn?.split(':').pop() ?? ''),
                            soundcloud_permalink: stripQueryParams(selectedScTrack.permalink_url || ''),
                          });
                        }}
                        disabled={!selectedScTrack}
                        title="Copy from SoundCloud"
                      >
                        <Cloud className="h-3 w-3" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6"
                        onClick={() => setCommentData({ soundcloud_id: '', soundcloud_permalink: '' })}
                        disabled={!commentData.soundcloud_id && !commentData.soundcloud_permalink}
                        title="Clear linked track"
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  </div>
                  <div className="space-y-2">
                    {commentData.soundcloud_id && (
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <span>ID:</span>
                        <a
                          href={commentData.soundcloud_permalink || `https://soundcloud.com/tracks/${commentData.soundcloud_id}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-mono hover:underline"
                        >
                          {commentData.soundcloud_id}
                        </a>
                      </div>
                    )}
                    {commentData.soundcloud_permalink && (
                      <div className="text-xs text-muted-foreground truncate">
                        <a
                          href={commentData.soundcloud_permalink}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="hover:underline"
                        >
                          {commentData.soundcloud_permalink}
                        </a>
                      </div>
                    )}
                    {!commentData.soundcloud_id && !commentData.soundcloud_permalink && (
                      <p className="text-xs text-muted-foreground">No SoundCloud track linked</p>
                    )}
                  </div>
                </Field>

                {/* Remix Editor */}
                <div className="pt-4 space-y-3 border-t">
                  <div className="flex items-center gap-2">
                    <Checkbox
                      id="is-remix"
                      checked={isRemix}
                      onCheckedChange={(checked) => setIsRemix(checked as boolean)}
                    />
                    <label htmlFor="is-remix" className="text-sm font-medium cursor-pointer">
                      This is a Remix
                    </label>
                  </div>

                  {isRemix && (
                    <div className="space-y-3 pl-6">
                      <Field>
                        <div className="flex items-center justify-between mb-2">
                          <FieldLabel>Original Artist</FieldLabel>
                          <div className="flex gap-1">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-6 w-6"
                              onClick={async () => {
                                if (!remixData.original_artist) return;
                                const transformed = cleanArtist(remixData.original_artist);
                                if (transformed !== remixData.original_artist) setRemixData({ ...remixData, original_artist: transformed });
                              }}
                              title="Clean artist"
                            >
                              <Sparkles className="h-3 w-3" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-6 w-6"
                              onClick={async () => {
                                if (!remixData.original_artist) return;
                                const transformed = titelize(remixData.original_artist);
                                if (transformed !== remixData.original_artist) setRemixData({ ...remixData, original_artist: transformed });
                              }}
                              title="Titelize"
                            >
                              <CaseSensitive className="h-3 w-3" />
                            </Button>
                            <Popover>
                              <PopoverTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-6 w-6"
                                  disabled={!selectedScTrack || !scArtistOptions.length}
                                  title="Artist options"
                                >
                                  <Users className="h-3 w-3" />
                                </Button>
                              </PopoverTrigger>
                              <PopoverContent className="w-48 p-2">
                                <div className="space-y-1">
                                  {scArtistOptions.map((artist) => (
                                    <Button
                                      key={artist}
                                      variant="ghost"
                                      size="sm"
                                      className="w-full justify-start"
                                      onClick={() => setRemixData({ ...remixData, original_artist: artist })}
                                    >
                                      {artist}
                                    </Button>
                                  ))}
                                </div>
                              </PopoverContent>
                            </Popover>
                          </div>
                        </div>
                        <Input
                          value={remixData.original_artist}
                          onChange={(e) => handleRemixChange('original_artist', e.target.value)}
                          placeholder="Original track artist"
                        />
                      </Field>

                      <Field>
                        <div className="flex items-center justify-between mb-2">
                          <FieldLabel>Remixer</FieldLabel>
                          <div className="flex gap-1">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-6 w-6"
                              onClick={async () => {
                                if (!remixData.remixer) return;
                                const transformed = cleanArtist(remixData.remixer);
                                if (transformed !== remixData.remixer) setRemixData({ ...remixData, remixer: transformed });
                              }}
                              title="Clean artist"
                            >
                              <Sparkles className="h-3 w-3" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-6 w-6"
                              onClick={async () => {
                                if (!remixData.remixer) return;
                                const transformed = titelize(remixData.remixer);
                                if (transformed !== remixData.remixer) setRemixData({ ...remixData, remixer: transformed });
                              }}
                              title="Titelize"
                            >
                              <CaseSensitive className="h-3 w-3" />
                            </Button>
                            <Popover>
                              <PopoverTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-6 w-6"
                                  disabled={!selectedScTrack || !scArtistOptions.length}
                                  title="Artist options"
                                >
                                  <Users className="h-3 w-3" />
                                </Button>
                              </PopoverTrigger>
                              <PopoverContent className="w-48 p-2">
                                <div className="space-y-1">
                                  {scArtistOptions.map((artist) => (
                                    <Button
                                      key={artist}
                                      variant="ghost"
                                      size="sm"
                                      className="w-full justify-start"
                                      onClick={() => setRemixData({ ...remixData, remixer: artist })}
                                    >
                                      {artist}
                                    </Button>
                                  ))}
                                </div>
                              </PopoverContent>
                            </Popover>
                          </div>
                        </div>
                        <Input
                          value={remixData.remixer}
                          onChange={(e) => handleRemixChange('remixer', e.target.value)}
                          placeholder="Who remixed it"
                        />
                      </Field>

                      <Field>
                        <div className="flex items-center justify-between mb-2">
                          <FieldLabel>Mix Name</FieldLabel>
                          <div className="flex gap-1">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-6 w-6"
                              onClick={async () => {
                                if (!remixData.mix_name) return;
                                const transformed = titelize(remixData.mix_name);
                                if (transformed !== remixData.mix_name) setRemixData({ ...remixData, mix_name: transformed });
                              }}
                              title="Titelize"
                            >
                              <CaseSensitive className="h-3 w-3" />
                            </Button>
                          </div>
                        </div>
                        <Select
                          value={remixData.mix_name}
                          onValueChange={(value) => handleRemixChange('mix_name', value)}
                        >
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="Remix">Remix</SelectItem>
                            <SelectItem value="VIP Mix">VIP Mix</SelectItem>
                            <SelectItem value="Extended Mix">Extended Mix</SelectItem>
                            <SelectItem value="Radio Edit">Radio Edit</SelectItem>
                            <SelectItem value="Club Mix">Club Mix</SelectItem>
                            <SelectItem value="Dub Mix">Dub Mix</SelectItem>
                          </SelectContent>
                        </Select>
                      </Field>
                    </div>
                  )}
                </div>

                {/* Artwork Management */}
                <div className="pt-4 space-y-3 border-t">
                  <div className="text-sm font-medium">Artwork</div>

                  {artworkUrl ? (
                    <div className="space-y-2">
                      <div className="relative w-48 h-48 border rounded-lg overflow-hidden bg-muted">
                        <img
                          src={artworkUrl}
                          alt="Track artwork"
                          className="w-full h-full object-cover"
                        />
                      </div>
                      <div className="flex gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            const input = document.createElement('input');
                            input.type = 'file';
                            input.accept = 'image/*';
                            input.onchange = handleArtworkUpload as any;
                            input.click();
                          }}
                          disabled={artworkUploading}
                        >
                          {artworkUploading ? 'Uploading...' : 'Replace'}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={handleRemoveArtwork}
                          disabled={loading}
                        >
                          Remove
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <div className="w-48 h-48 border-2 border-dashed rounded-lg flex items-center justify-center bg-muted">
                        <p className="text-sm text-muted-foreground">No artwork</p>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          const input = document.createElement('input');
                          input.type = 'file';
                          input.accept = 'image/*';
                          input.onchange = handleArtworkUpload as any;
                          input.click();
                        }}
                        disabled={artworkUploading}
                      >
                        {artworkUploading ? 'Uploading...' : 'Upload Artwork'}
                      </Button>
                    </div>
                  )}
                </div>

                <div className="pt-4 space-y-2 border-t">
                  <div className="text-sm font-medium">File Status</div>
                  <div className="text-sm">
                    <strong>Ready for finalization:</strong>{' '}
                    <span className={trackInfo.is_ready ? 'text-green-600' : 'text-red-600'}>
                      {trackInfo.is_ready ? 'Yes ✓' : 'No ✗'}
                    </span>
                  </div>
                  {trackInfo.missing_fields.length > 0 && (
                    <div className="text-sm text-muted-foreground">
                      <strong>Missing:</strong> {trackInfo.missing_fields.join(', ')}
                    </div>
                  )}
                  {trackInfo.issues.length > 0 && (
                    <div className="text-sm text-amber-600">
                      <strong>Issues:</strong> {trackInfo.issues.join(', ')}
                    </div>
                  )}
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* SoundCloud Search */}
        <Card className="lg:col-span-1">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Checkbox
                checked={scSearchEnabled}
                onCheckedChange={(checked) => setScSearchEnabled(checked as boolean)}
              />
              SoundCloud
            </CardTitle>
          </CardHeader>
          <CardContent>
            {scSearchEnabled ? (
              <div className="space-y-4">
                <Field>
                  <FieldLabel>Search</FieldLabel>
                  <div className="flex gap-2">
                    <Input
                      value={scQuery}
                      onChange={(e) => setScQuery(e.target.value)}
                      placeholder="Search tracks..."
                      onKeyDown={(e) => e.key === 'Enter' && handleScSearch()}
                    />
                    <Button
                      onClick={handleScSearch}
                      disabled={scSearching || !scQuery.trim()}
                      size="sm"
                    >
                      {scSearching ? '...' : 'Go'}
                    </Button>
                  </div>
                </Field>

                {/* Selected track preview */}
                {selectedScTrack && (
                  <div className="space-y-3 p-3 border rounded bg-card">
                    <iframe
                      width="100%"
                      height="166"
                      scrolling="no"
                      frameBorder="no"
                      allow="autoplay"
                      src={`https://w.soundcloud.com/player/?url=${encodeURIComponent(selectedScTrack.permalink_url ?? '')}&color=%23ff5500&auto_play=false&hide_related=false&show_comments=true&show_user=true&show_reposts=false&show_teaser=true&visual=true`}
                      className="rounded"
                    />
                    <div className="flex gap-2">
                      <Button
                        onClick={() => handleApplyScMetadata(selectedScTrack)}
                        disabled={!trackInfo}
                        size="sm"
                        className="flex-1"
                      >
                        Apply Metadata
                      </Button>
                      <Button
                        onClick={() => setSelectedScTrack(null)}
                        variant="outline"
                        size="sm"
                      >
                        Clear
                      </Button>
                    </div>
                  </div>
                )}

                <div className="space-y-2 max-h-[500px] overflow-y-auto">
                  {scResults.map((track) => (
                    <button
                      key={track.urn}
                      onClick={() => handleScTrackSelect(track)}
                      className={`w-full text-left p-3 rounded border hover:bg-accent transition-colors ${
                        selectedScTrack?.urn === track.urn ? 'bg-accent border-primary' : ''
                      }`}
                    >
                      <div className="text-sm font-medium truncate">{track.title}</div>
                      <div className="text-xs text-muted-foreground truncate">{track.user?.username}</div>
                      {track.genre && (
                        <div className="text-xs text-muted-foreground">{track.genre}</div>
                      )}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                Enable SoundCloud search to find and apply track metadata
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
