'use client';

import { useState, useEffect } from 'react';
import { api, type FileInfo, type TrackInfo, type SoundCloudTrack } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
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
  const [scResults, setScResults] = useState<SoundCloudTrack[]>([]);
  const [scSearching, setScSearching] = useState(false);
  const [selectedScTrack, setSelectedScTrack] = useState<SoundCloudTrack | null>(null);

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
    comment: '',
    release_date: '',
  });

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

  // Update form when track info loads
  useEffect(() => {
    if (trackInfo) {
      setFormData({
        title: trackInfo.title || '',
        artist: trackInfo.artist || '',
        bpm: trackInfo.bpm?.toString() || '',
        key: trackInfo.key || '',
        genre: trackInfo.genre || '',
        comment: trackInfo.comment || '',
        release_date: trackInfo.release_date || '',
      });

      // Set remix data
      if (trackInfo.remixers && trackInfo.remixers.length > 0) {
        setIsRemix(true);
        setRemixData({
          original_artist: trackInfo.artist || '',
          remixer: trackInfo.remixers[0],
          mix_name: 'Remix',
        });
      } else {
        setIsRemix(false);
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
  const handleCleanTitle = async () => {
    if (!formData.title) return;
    try {
      const result = await api.cleanTitle(formData.title);
      if (result.changed) {
        setFormData({ ...formData, title: result.transformed });
      }
    } catch (err) {
      console.error('Failed to clean title:', err);
    }
  };

  const handleCleanArtist = async () => {
    if (!formData.artist) return;
    try {
      const result = await api.cleanArtist(formData.artist);
      if (result.changed) {
        setFormData({ ...formData, artist: result.transformed });
      }
    } catch (err) {
      console.error('Failed to clean artist:', err);
    }
  };

  const handleTitelize = async () => {
    try {
      const updates: Partial<typeof formData> = {};

      if (formData.title) {
        const result = await api.titelize(formData.title);
        if (result.changed) updates.title = result.transformed;
      }

      if (formData.artist) {
        const result = await api.titelize(formData.artist);
        if (result.changed) updates.artist = result.transformed;
      }

      if (Object.keys(updates).length > 0) {
        setFormData({ ...formData, ...updates });
      }
    } catch (err) {
      console.error('Failed to titelize:', err);
    }
  };

  const handleRemoveOriginalMix = async () => {
    if (!formData.title) return;
    try {
      const result = await api.removeOriginalMix(formData.title);
      if (result.changed) {
        setFormData({ ...formData, title: result.transformed });
      }
    } catch (err) {
      console.error('Failed to remove original mix:', err);
    }
  };

  const handleRemoveParenthesis = async () => {
    if (!formData.title) return;
    try {
      const result = await api.removeParenthesis(formData.title);
      if (result.changed) {
        setFormData({ ...formData, title: result.transformed });
      }
    } catch (err) {
      console.error('Failed to remove parenthesis:', err);
    }
  };

  const handleApplyAllAutoActions = async () => {
    await handleCleanTitle();
    await handleCleanArtist();
  };

  // Field-specific copy from SoundCloud
  const handleCopyFromSc = (field: keyof typeof formData) => {
    if (!selectedScTrack) return;

    const scFieldMap: Record<string, any> = {
      title: selectedScTrack.title,
      artist: selectedScTrack.artist,
      genre: selectedScTrack.genre,
      release_date: selectedScTrack.release_date,
    };

    if (field in scFieldMap) {
      setFormData({ ...formData, [field]: scFieldMap[field] || '' });
    }
  };

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
      setFormData({
        title: '',
        artist: '',
        bpm: '',
        key: '',
        genre: '',
        comment: '',
        release_date: '',
      });
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
      setFormData({
        title: '',
        artist: '',
        bpm: '',
        key: '',
        genre: '',
        comment: '',
        release_date: '',
      });
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
      const result = await api.searchSoundCloud(scQuery);
      setScResults(result.tracks);
      // Auto-select first result
      setSelectedScTrack(result.tracks.length > 0 ? result.tracks[0] : null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'SoundCloud search failed');
    } finally {
      setScSearching(false);
    }
  };

  const handleScTrackSelect = (track: SoundCloudTrack) => {
    setSelectedScTrack(track);
  };

  const handleApplyScMetadata = async (track: SoundCloudTrack) => {
    if (!trackInfo) return;

    try {
      setLoading(true);
      setError(null);
      await api.applySoundCloudMetadata(trackInfo.file_path, track.id);

      // Reload track info
      await loadTrackInfo(selectedFile!);
      alert('SoundCloud metadata applied');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to apply metadata');
    } finally {
      setLoading(false);
    }
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
                {/* Auto-Actions Toolbar */}
                <div className="flex flex-wrap gap-2 pb-4 border-b">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleApplyAllAutoActions}
                    title="Clean title and artist (remove free DL, premiere, normalize separators)"
                  >
                    <Sparkles className="h-4 w-4 mr-2" />
                    Clean
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleTitelize}
                    title="Properly capitalize title and artist"
                  >
                    <CaseSensitive className="h-4 w-4 mr-2" />
                    Titelize
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleRemoveOriginalMix}
                    title="Remove '(Original Mix)' from title"
                  >
                    <Trash2 className="h-4 w-4 mr-2" />
                    Remove Original Mix
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleRemoveParenthesis}
                    title="Remove square brackets from title"
                  >
                    <Brackets className="h-4 w-4 mr-2" />
                    Remove Brackets
                  </Button>
                </div>

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
                          const result = await api.titelize(formData.title);
                          if (result.changed) setFormData({ ...formData, title: result.transformed });
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
                          const result = await api.titelize(formData.artist);
                          if (result.changed) setFormData({ ...formData, artist: result.transformed });
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
                            disabled={!selectedScTrack || !selectedScTrack.artist_options?.length}
                            title="Artist options"
                          >
                            <Users className="h-3 w-3" />
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent className="w-48 p-2">
                          <div className="space-y-1">
                            {selectedScTrack?.artist_options?.map((artist) => (
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
                          const result = await api.titelize(formData.genre);
                          if (result.changed) setFormData({ ...formData, genre: result.transformed });
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
                  <FieldLabel>Comment</FieldLabel>
                  <Textarea
                    value={formData.comment}
                    onChange={(e) => handleFormChange('comment', e.target.value)}
                    rows={3}
                  />
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
                                const result = await api.cleanArtist(remixData.original_artist);
                                if (result.changed) setRemixData({ ...remixData, original_artist: result.transformed });
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
                                const result = await api.titelize(remixData.original_artist);
                                if (result.changed) setRemixData({ ...remixData, original_artist: result.transformed });
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
                                  disabled={!selectedScTrack || !selectedScTrack.artist_options?.length}
                                  title="Artist options"
                                >
                                  <Users className="h-3 w-3" />
                                </Button>
                              </PopoverTrigger>
                              <PopoverContent className="w-48 p-2">
                                <div className="space-y-1">
                                  {selectedScTrack?.artist_options?.map((artist) => (
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
                                const result = await api.cleanArtist(remixData.remixer);
                                if (result.changed) setRemixData({ ...remixData, remixer: result.transformed });
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
                                const result = await api.titelize(remixData.remixer);
                                if (result.changed) setRemixData({ ...remixData, remixer: result.transformed });
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
                                  disabled={!selectedScTrack || !selectedScTrack.artist_options?.length}
                                  title="Artist options"
                                >
                                  <Users className="h-3 w-3" />
                                </Button>
                              </PopoverTrigger>
                              <PopoverContent className="w-48 p-2">
                                <div className="space-y-1">
                                  {selectedScTrack?.artist_options?.map((artist) => (
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
                                const result = await api.titelize(remixData.mix_name);
                                if (result.changed) setRemixData({ ...remixData, mix_name: result.transformed });
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
                      src={`https://w.soundcloud.com/player/?url=https://api.soundcloud.com/tracks/${selectedScTrack.id}&color=%23ff5500&auto_play=false&hide_related=false&show_comments=true&show_user=true&show_reposts=false&show_teaser=true&visual=true`}
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
                      key={track.id}
                      onClick={() => handleScTrackSelect(track)}
                      className={`w-full text-left p-3 rounded border hover:bg-accent transition-colors ${
                        selectedScTrack?.id === track.id ? 'bg-accent border-primary' : ''
                      }`}
                    >
                      <div className="text-sm font-medium truncate">{track.title}</div>
                      <div className="text-xs text-muted-foreground truncate">{track.artist}</div>
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
