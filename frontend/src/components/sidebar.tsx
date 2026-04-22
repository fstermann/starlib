"use client";

import { Moon, Settings, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { useCommand } from "@/components/command-palette";
import { SoundCloudLogo } from "@/components/icons/soundcloud-logo";
import { SettingsDialog } from "@/components/settings-dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { clearTokens } from "@/lib/auth";
import { NAV_LINKS } from "@/lib/nav-config";

interface User {
  id: number;
  username: string;
  permalink: string;
  avatar_url: string | null;
}

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { resolvedTheme, setTheme } = useTheme();
  const [user, setUser] = useState<User | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Palette commands (lifecycle-bound — here since sidebar is always mounted).
  const runSettings = useCallback(({ close }: { close: () => void }) => {
    setSettingsOpen(true);
    close();
  }, []);
  useCommand({
    id: "settings:open",
    label: "Open Settings",
    group: "Actions",
    icon: Settings,
    keywords: ["preferences", "config"],
    run: runSettings,
  });

  const runToggleTheme = useCallback(
    ({ close }: { close: () => void }) => {
      setTheme(resolvedTheme === "dark" ? "light" : "dark");
      close();
    },
    [resolvedTheme, setTheme],
  );
  useCommand({
    id: "theme:toggle",
    label: `Switch to ${resolvedTheme === "dark" ? "Light" : "Dark"} Theme`,
    group: "Actions",
    icon: resolvedTheme === "dark" ? Sun : Moon,
    keywords: ["theme", "appearance", "dark", "light", "mode"],
    run: runToggleTheme,
  });

  const runConnect = useCallback(
    ({ close }: { close: () => void }) => {
      router.push("/auth/login");
      close();
    },
    [router],
  );
  useCommand({
    id: "auth:connect",
    label: "Connect SoundCloud",
    group: "Actions",
    icon: SoundCloudLogo,
    keywords: ["login", "sign in", "auth"],
    when: !user,
    run: runConnect,
  });

  const runDisconnect = useCallback(
    ({ close }: { close: () => void }) => {
      clearTokens();
      setUser(null);
      router.push("/");
      close();
    },
    [router],
  );
  useCommand({
    id: "auth:disconnect",
    label: user
      ? `Disconnect SoundCloud (${user.username})`
      : "Disconnect SoundCloud",
    group: "Actions",
    icon: SoundCloudLogo,
    keywords: ["logout", "sign out", "auth"],
    when: !!user,
    run: runDisconnect,
  });

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
