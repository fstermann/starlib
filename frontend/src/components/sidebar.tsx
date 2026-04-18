"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { FilePen, Heart, Settings, CalendarDays } from "lucide-react";
import { clearTokens } from "@/lib/auth";
import { SettingsDialog } from "@/components/settings-dialog";
import { SoundCloudLogo } from "@/components/icons/soundcloud-logo";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

interface User {
  id: number;
  username: string;
  permalink: string;
  avatar_url: string | null;
}

const NAV_LINKS = [
  { href: "/meta-editor", label: "Meta Editor", icon: FilePen },
  { href: "/like-explorer", label: "Like Explorer", icon: Heart },
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
    <aside className="fixed left-0 top-0 bottom-0 z-50 flex w-14 flex-col border-r border-border/50 bg-card shrink-0">
      {/* Logo */}
      <div className="h-14 flex items-center justify-center shrink-0">
        <Link href="/" aria-label="Starlib home">
          <span
            className="size-6 block bg-primary"
            style={{
              maskImage: 'url(/starlib-logo.svg)',
              WebkitMaskImage: 'url(/starlib-logo.svg)',
              maskSize: 'contain',
              WebkitMaskSize: 'contain',
              maskRepeat: 'no-repeat',
              WebkitMaskRepeat: 'no-repeat',
              maskPosition: 'center',
              WebkitMaskPosition: 'center',
            }}
          />
        </Link>
      </div>

      {/* Nav links */}
      <nav className="flex-1 py-3 flex flex-col gap-1 px-2">
        {NAV_LINKS.map(({ href, label, icon: Icon }) => {
          const active = pathname.startsWith(href);
          return (
            <Tooltip key={href}>
              <TooltipTrigger asChild>
                <Link
                  href={href}
                  aria-label={label}
                  className={`flex items-center justify-center size-9 rounded-md transition-colors ${
                    active
                      ? "text-[var(--brand)] bg-[var(--brand-soft)]"
                      : "text-muted-foreground hover:text-foreground hover:bg-accent/50"
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
      <div className="px-2 pb-1 shrink-0">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={() => setSettingsOpen(true)}
              aria-label="Settings"
              className="flex items-center justify-center size-9 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors cursor-pointer"
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
      <div className="px-2 py-3 shrink-0">
        {user ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={handleDisconnect}
                aria-label="Disconnect SoundCloud"
                className="flex items-center justify-center size-9 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
              >
                {user.avatar_url ? (
                  <span className="relative flex items-center justify-center">
                    <img
                      src={user.avatar_url}
                      alt={user.username}
                      className="size-5 rounded-full object-cover"
                    />
                    <SoundCloudLogo className="absolute -bottom-0.5 -right-0.5 size-2.5" />
                  </span>
                ) : (
                  <div className="size-5 rounded-full bg-primary/20 flex items-center justify-center text-[9px] font-bold text-primary">
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
                className="flex items-center justify-center size-9 rounded-md text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors"
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
