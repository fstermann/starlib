import {
  CalendarDays,
  Compass,
  Disc3,
  FolderOpen,
  Heart,
  Search,
} from "lucide-react";
import type { ComponentType, SVGProps } from "react";

import { LibraryIcon } from "@/components/icons/library-icon";
import { SoundCloudLogo } from "@/components/icons/soundcloud-logo";

export type NavIcon = ComponentType<
  SVGProps<SVGSVGElement> & { size?: string | number }
>;

export interface NavLink {
  href: string;
  label: string;
  icon: NavIcon;
  keywords?: string[];
}

/** Top-level destinations rendered in the sidebar. */
export const NAV_LINKS: NavLink[] = [
  {
    href: "/library",
    label: "Library",
    icon: LibraryIcon,
    keywords: ["tracks", "filesystem", "soundcloud", "likes", "rekordbox"],
  },
  {
    href: "/weekly",
    label: "Weekly Favorites",
    icon: CalendarDays,
    keywords: ["releases", "followed", "artists"],
  },
];

/** Secondary destinations — exposed in the command palette but not the sidebar. */
export const QUICK_JUMPS: NavLink[] = [
  {
    href: "/library?source=filesystem",
    label: "Library: Filesystem",
    icon: FolderOpen,
    keywords: ["local", "files", "metadata", "edit"],
  },
  {
    href: "/library?source=soundcloud&tab=me",
    label: "Library: SoundCloud — My Library",
    icon: SoundCloudLogo,
    keywords: ["likes", "playlists"],
  },
  {
    href: "/library?source=soundcloud&tab=discover",
    label: "Library: SoundCloud — Discover",
    icon: Compass,
    keywords: ["user", "profile"],
  },
  {
    href: "/library?source=soundcloud&tab=search",
    label: "Library: SoundCloud — Search",
    icon: Search,
    keywords: ["find", "tracks"],
  },
  {
    href: "/library?source=rekordbox",
    label: "Library: Rekordbox",
    icon: Disc3,
    keywords: ["rekordbox", "playlists", "pioneer", "dj"],
  },
  {
    href: "/weekly",
    label: "Weekly Favorites",
    icon: Heart,
    keywords: ["releases", "new"],
  },
];
