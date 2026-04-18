"use client";

import { Search } from "lucide-react";
import { useRef, useState } from "react";

import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { resolveUrl, searchUsers, type SCUser } from "@/lib/soundcloud";

interface UserSearchProps {
  onSelect: (user: SCUser) => void;
}

export function UserSearch({ onSelect }: UserSearchProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SCUser[]>([]);
  const [searching, setSearching] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function handleChange(value: string) {
    setQuery(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (!value.trim()) {
      setResults([]);
      return;
    }

    debounceRef.current = setTimeout(async () => {
      setSearching(true);
      try {
        if (value.includes("soundcloud.com/")) {
          const resolved = await resolveUrl(value.trim());
          if (resolved && "username" in resolved && resolved.kind === "user") {
            setResults([resolved as SCUser]);
          } else {
            setResults([]);
          }
        } else {
          const users = await searchUsers(value.trim());
          setResults(users);
        }
      } catch {
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, 500);
  }

  return (
    <div className="space-y-3">
      <div className="relative">
        <Search className="text-muted-foreground absolute top-1/2 left-3 size-4 -translate-y-1/2" />
        <Input
          value={query}
          onChange={(e) => handleChange(e.target.value)}
          placeholder="Search users or paste a SoundCloud profile URL…"
          className="pl-9"
        />
      </div>

      {searching && <p className="text-muted-foreground text-xs">Searching…</p>}

      {results.length > 0 && (
        <div className="grid gap-2">
          {results
            .filter((u): u is NonNullable<typeof u> => u != null)
            .map((user) => {
              const avatarUrl = user.avatar_url
                ? api.proxyImageUrl(user.avatar_url)
                : null;
              return (
                <button
                  key={user.urn ?? user.permalink}
                  onClick={() => {
                    onSelect(user);
                    setQuery("");
                    setResults([]);
                  }}
                  className="border-border hover:border-primary/40 hover:bg-accent flex cursor-pointer items-center gap-3 rounded-lg border p-3 text-left transition-colors"
                >
                  <div className="bg-muted flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-full">
                    {avatarUrl ? (
                      <img
                        src={avatarUrl}
                        alt=""
                        className="size-10 object-cover"
                      />
                    ) : (
                      <span className="text-muted-foreground text-sm font-medium">
                        {(user.username ?? "?")[0].toUpperCase()}
                      </span>
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                      {user.username}
                    </p>
                    <p className="text-muted-foreground text-xs">
                      {user.followers_count?.toLocaleString() ?? 0} followers
                      {user.track_count != null &&
                        ` · ${user.track_count} tracks`}
                    </p>
                  </div>
                </button>
              );
            })}
        </div>
      )}
    </div>
  );
}
