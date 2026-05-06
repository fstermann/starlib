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
  // Tracks the latest query the user typed so a slow in-flight response for
  // an older query can't restore stale results after the user has cleared
  // the input or moved on to something else.
  const latestQueryRef = useRef("");

  function handleChange(value: string) {
    setQuery(value);
    latestQueryRef.current = value;
    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (!value.trim()) {
      setResults([]);
      setSearching(false);
      return;
    }

    debounceRef.current = setTimeout(async () => {
      setSearching(true);
      try {
        if (value.includes("soundcloud.com/")) {
          const resolved = await resolveUrl(value.trim());
          if (latestQueryRef.current !== value) return;
          if (resolved && "username" in resolved && resolved.kind === "user") {
            setResults([resolved as SCUser]);
          } else {
            setResults([]);
          }
        } else {
          const users = await searchUsers(value.trim());
          if (latestQueryRef.current !== value) return;
          setResults(users);
        }
      } catch {
        if (latestQueryRef.current !== value) return;
        setResults([]);
      } finally {
        if (latestQueryRef.current === value) setSearching(false);
      }
    }, 500);
  }

  const showResults = searching || results.length > 0;

  return (
    <div className="relative">
      <div className="relative">
        <Search className="text-muted-foreground absolute top-1/2 left-3 size-4 -translate-y-1/2" />
        <Input
          value={query}
          onChange={(e) => handleChange(e.target.value)}
          placeholder="Search users or paste a SoundCloud profile URL…"
          className="pl-9"
        />
      </div>

      {showResults && (
        // Absolute overlay so the result list floats on top of whatever
        // page content sits below the search input (likes table, etc.)
        // instead of being clipped at its bottom edge.
        <div className="bg-popover border-border absolute top-full right-0 left-0 z-50 mt-2 max-h-[60vh] space-y-2 overflow-auto rounded-md border p-2 shadow-lg">
          {searching && (
            <p className="text-muted-foreground text-xs">Searching…</p>
          )}
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
                    // Bust the in-flight stale-response guard so any
                    // searchUsers call still pending for the just-cleared
                    // query is dropped instead of re-populating results.
                    latestQueryRef.current = "";
                    if (debounceRef.current) clearTimeout(debounceRef.current);
                    setQuery("");
                    setResults([]);
                    setSearching(false);
                  }}
                  className="border-border hover:border-primary/40 hover:bg-accent flex w-full cursor-pointer items-center gap-3 rounded-lg border p-3 text-left transition-colors"
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
