'use client';

import { useState } from 'react';
import { createPlaylist, type SCTrack } from '@/lib/soundcloud';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { ListPlus } from 'lucide-react';

const MAX_TRACKS = 500;

interface CreatePlaylistDialogProps {
  tracks: SCTrack[];
  trigger?: React.ReactNode;
}

function extractUrn(track: SCTrack): string | undefined {
  return track.urn ?? undefined;
}

function formatTotalDuration(tracks: SCTrack[]): string {
  const totalMs = tracks.reduce((sum, t) => sum + (t.duration ?? 0), 0);
  const totalMin = Math.floor(totalMs / 60000);
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

export function CreatePlaylistDialog({ tracks, trigger }: CreatePlaylistDialogProps) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [isPublic, setIsPublic] = useState(false);
  const [creating, setCreating] = useState(false);
  const [result, setResult] = useState<{ url: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const trackUrns = tracks.slice(0, MAX_TRACKS).map((t) => extractUrn(t)).filter((urn): urn is string => urn != null);
  const truncated = tracks.length > MAX_TRACKS;

  async function handleCreate() {
    if (!title.trim() || trackUrns.length === 0) return;
    setCreating(true);
    setError(null);
    try {
      const playlist = await createPlaylist(title.trim(), trackUrns, {
        description: description.trim() || undefined,
        sharing: isPublic ? 'public' : 'private',
      });
      const url = (playlist as Record<string, unknown>).permalink_url as string | undefined;
      setResult({ url: url ?? '' });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create playlist');
    } finally {
      setCreating(false);
    }
  }

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (next) {
      // Reset form on open
      setTitle(`Liked tracks – ${new Date().toLocaleDateString()}`);
      setDescription('');
      setIsPublic(false);
      setResult(null);
      setError(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button size="sm" variant="default">
            <ListPlus className="size-4 mr-1.5" />
            Create Playlist ({tracks.length})
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create SoundCloud Playlist</DialogTitle>
          <DialogDescription>
            {tracks.length} track{tracks.length !== 1 ? 's' : ''} · {formatTotalDuration(tracks)}
            {truncated && (
              <span className="text-destructive">
                {' '}(limited to {MAX_TRACKS} – {tracks.length - MAX_TRACKS} tracks will be excluded)
              </span>
            )}
          </DialogDescription>
        </DialogHeader>

        {result ? (
          <div className="py-4 text-center space-y-3">
            <p className="text-sm text-muted-foreground">Playlist created successfully!</p>
            {result.url && (
              <a
                href={result.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-primary underline"
              >
                Open on SoundCloud
              </a>
            )}
            <div>
              <Button variant="outline" size="sm" onClick={() => setOpen(false)}>
                Close
              </Button>
            </div>
          </div>
        ) : (
          <>
            <div className="space-y-4 py-2">
              <div className="space-y-2">
                <Label htmlFor="playlist-title">Title</Label>
                <Input
                  id="playlist-title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Playlist title"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="playlist-description">Description</Label>
                <Input
                  id="playlist-description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Optional description"
                />
              </div>
              <div className="flex items-center gap-2">
                <Checkbox
                  id="playlist-public"
                  checked={isPublic}
                  onCheckedChange={(v) => setIsPublic(v === true)}
                />
                <Label htmlFor="playlist-public" className="text-sm font-normal">
                  Make playlist public
                </Label>
              </div>
              {error && <p className="text-sm text-destructive">{error}</p>}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button onClick={handleCreate} disabled={creating || !title.trim() || trackUrns.length === 0}>
                {creating ? 'Creating…' : 'Create'}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
