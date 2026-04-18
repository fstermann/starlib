"use client";

import { X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import type { SCUser } from "@/lib/soundcloud";

interface UserCardProps {
  user: NonNullable<SCUser>;
  onClear: () => void;
}

export function UserCard({ user, onClear }: UserCardProps) {
  const avatarUrl = user.avatar_url ? api.proxyImageUrl(user.avatar_url) : null;

  const profileHref = user.permalink_url ?? null;

  return (
    <div className="border-border bg-card flex items-center gap-3 rounded-lg border px-4 py-3">
      <a
        href={profileHref ?? undefined}
        target="_blank"
        rel="noopener noreferrer"
        className={`flex min-w-0 flex-1 items-center gap-3 ${profileHref ? "cursor-pointer transition-opacity hover:opacity-80" : "cursor-default"}`}
        onClick={profileHref ? undefined : (e) => e.preventDefault()}
      >
        <div className="bg-muted flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-full">
          {avatarUrl ? (
            <img src={avatarUrl} alt="" className="size-10 object-cover" />
          ) : (
            <span className="text-muted-foreground text-sm font-medium">
              {(user.username ?? "?")[0].toUpperCase()}
            </span>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{user.username}</p>
          <p className="text-muted-foreground text-xs">
            {user.followers_count?.toLocaleString() ?? 0} followers
            {user.track_count != null && ` · ${user.track_count} tracks`}
            {user.public_favorites_count != null &&
              ` · ${user.public_favorites_count} likes`}
          </p>
        </div>
      </a>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 shrink-0 text-xs"
        onClick={onClear}
      >
        <X className="mr-1 size-3.5" />
        Clear
      </Button>
    </div>
  );
}
