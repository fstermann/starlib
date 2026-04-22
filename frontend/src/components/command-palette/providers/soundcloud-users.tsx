"use client";

import { User as UserIcon } from "lucide-react";
import { useMemo } from "react";

import type { CommandProvider } from "@/components/command-palette/types";
import { api } from "@/lib/api";
import { resolveUrl, searchUsers, type SCUser } from "@/lib/soundcloud";

import { useRegisterProvider } from "../use-register-provider";

const PROFILE_URL_RE = /^https?:\/\/(www\.)?soundcloud\.com\/[^/]+\/?$/i;

export function SoundcloudUsersProvider({
  onSelect,
}: {
  onSelect: (user: SCUser) => void;
}) {
  const provider = useMemo<CommandProvider>(
    () => ({
      id: "sc-users",
      order: 40,
      mode: "async",
      minQueryLength: 2,
      provide: async (query, signal) => {
        const trimmed = query.trim();
        if (!trimmed) return [];
        let users: SCUser[] = [];
        if (PROFILE_URL_RE.test(trimmed)) {
          const resolved = await resolveUrl(trimmed);
          if (signal.aborted) return [];
          if (resolved && "username" in resolved && resolved.kind === "user") {
            users = [resolved as SCUser];
          }
        } else {
          users = await searchUsers(trimmed, 8);
          if (signal.aborted) return [];
        }
        const items = [];
        for (const u of users) {
          if (!u) continue;
          items.push({
            id: `sc-user:${u.urn ?? u.permalink}`,
            label: u.username ?? u.permalink ?? "User",
            description:
              u.followers_count != null
                ? `${u.followers_count.toLocaleString()} followers`
                : undefined,
            imageUrl: u.avatar_url
              ? api.proxyImageUrl(u.avatar_url)
              : undefined,
            icon: UserIcon,
            group: "SoundCloud Users",
            run: ({ close }: { close: () => void }) => {
              onSelect(u);
              close();
            },
          });
        }
        return items;
      },
    }),
    [onSelect],
  );

  useRegisterProvider(provider);
  return null;
}
