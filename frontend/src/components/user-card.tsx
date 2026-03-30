'use client';

import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import type { SCUser } from '@/lib/soundcloud';

interface UserCardProps {
  user: NonNullable<SCUser>;
  onClear: () => void;
}

export function UserCard({ user, onClear }: UserCardProps) {
  const avatarUrl = user.avatar_url ? api.proxyImageUrl(user.avatar_url) : null;

  const profileHref = user.permalink_url ?? null;

  return (
    <div className="flex items-center gap-3 px-4 py-3 rounded-lg border border-border/50 bg-card">
      <a
        href={profileHref ?? undefined}
        target="_blank"
        rel="noopener noreferrer"
        className={`flex items-center gap-3 min-w-0 flex-1 ${profileHref ? 'cursor-pointer hover:opacity-80 transition-opacity' : 'cursor-default'}`}
        onClick={profileHref ? undefined : (e) => e.preventDefault()}
      >
        <div className="size-10 shrink-0 rounded-full overflow-hidden bg-muted flex items-center justify-center">
          {avatarUrl
            ? <img src={avatarUrl} alt="" className="size-10 object-cover" />
            : <span className="text-sm font-medium text-muted-foreground">
                {(user.username ?? '?')[0].toUpperCase()}
              </span>}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium truncate">{user.username}</p>
          <p className="text-xs text-muted-foreground">
            {user.followers_count?.toLocaleString() ?? 0} followers
            {user.track_count != null && ` · ${user.track_count} tracks`}
            {user.public_favorites_count != null && ` · ${user.public_favorites_count} likes`}
          </p>
        </div>
      </a>
      <Button variant="ghost" size="sm" className="h-7 text-xs shrink-0" onClick={onClear}>
        <X className="size-3.5 mr-1" />
        Clear
      </Button>
    </div>
  );
}
