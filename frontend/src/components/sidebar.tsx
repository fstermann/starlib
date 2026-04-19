"use client";

import { CalendarDays, Settings } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { LibraryIcon } from "@/components/icons/library-icon";
import { SoundCloudLogo } from "@/components/icons/soundcloud-logo";
import { SettingsDialog } from "@/components/settings-dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { clearTokens } from "@/lib/auth";

interface User {
  id: number;
  username: string;
  permalink: string;
  avatar_url: string | null;
}

const NAV_LINKS = [
  { href: "/library", label: "Library", icon: LibraryIcon },
  { href: "/weekly", label: "Weekly Favorites", icon: CalendarDays },
];

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    const readUser = () => {
      try {
        const stored = localStorage.getItem("sc_user");
        setUser(stored ? JSON.parse(stored) : null);
      } catch {
        // ignore malformed data
      }
    };
    readUser();
    window.addEventListener("auth-changed", readUser);
    return () => window.removeEventListener("auth-changed", readUser);
  }, []);

  function handleDisconnect() {
    clearTokens();
    setUser(null);
    router.push("/");
  }

  return (
    <aside className="border-border bg-card fixed top-0 bottom-0 left-0 z-50 flex w-14 shrink-0 flex-col border-r">
      {/* Logo */}
      <div className="flex h-14 shrink-0 items-center justify-center">
        <Link href="/" aria-label="Starlib home">
          <span
            className="bg-primary block size-6"
            style={{
              maskImage: "url(/starlib-logo.svg)",
              WebkitMaskImage: "url(/starlib-logo.svg)",
              maskSize: "contain",
              WebkitMaskSize: "contain",
              maskRepeat: "no-repeat",
              WebkitMaskRepeat: "no-repeat",
              maskPosition: "center",
              WebkitMaskPosition: "center",
            }}
          />
        </Link>
      </div>

      {/* Nav links */}
      <nav className="flex flex-1 flex-col gap-1 px-2 py-3">
        {NAV_LINKS.map(({ href, label, icon: Icon }) => {
          const active = pathname.startsWith(href);
          return (
            <Tooltip key={href}>
              <TooltipTrigger asChild>
                <Link
                  href={href}
                  aria-label={label}
                  className={`flex size-9 items-center justify-center rounded-md transition-colors ${
                    active
                      ? "bg-[var(--brand-soft)] text-[var(--brand)]"
                      : "text-muted-foreground hover:text-foreground hover:bg-accent"
                  }`}
                >
                  <Icon className="size-4" />
                </Link>
              </TooltipTrigger>
              <TooltipContent side="right" showArrow={false}>
                {label}
              </TooltipContent>
            </Tooltip>
          );
        })}
      </nav>

      {/* Settings */}
      <div className="shrink-0 px-2 pb-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={() => setSettingsOpen(true)}
              aria-label="Settings"
              className="text-muted-foreground hover:text-foreground hover:bg-accent flex size-9 cursor-pointer items-center justify-center rounded-md transition-colors"
            >
              <Settings className="size-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right" showArrow={false}>
            Settings
          </TooltipContent>
        </Tooltip>
      </div>

      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />

      {/* User / disconnect */}
      <div className="shrink-0 px-2 py-3">
        {user ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={handleDisconnect}
                aria-label="Disconnect SoundCloud"
                className="text-muted-foreground hover:text-destructive hover:bg-destructive/10 flex size-9 items-center justify-center rounded-md transition-colors"
              >
                {user.avatar_url ? (
                  <span className="relative flex items-center justify-center">
                    <img
                      src={user.avatar_url}
                      alt={user.username}
                      className="size-5 rounded-full object-cover"
                    />
                    <SoundCloudLogo className="absolute -right-0.5 -bottom-0.5 size-2.5" />
                  </span>
                ) : (
                  <div className="bg-brand-soft text-primary flex size-5 items-center justify-center rounded-full text-xs font-bold">
                    {user.username.slice(0, 1).toUpperCase()}
                  </div>
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent side="right" showArrow={false}>
              Disconnect {user.username}
            </TooltipContent>
          </Tooltip>
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>
              <Link
                href="/auth/login"
                aria-label="Connect SoundCloud"
                className="text-muted-foreground hover:text-primary hover:bg-brand-soft flex size-9 items-center justify-center rounded-md transition-colors"
              >
                <SoundCloudLogo className="size-4" />
              </Link>
            </TooltipTrigger>
            <TooltipContent side="right" showArrow={false}>
              Connect SoundCloud
            </TooltipContent>
          </Tooltip>
        )}
      </div>
    </aside>
  );
}
