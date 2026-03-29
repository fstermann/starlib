"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Music2, FilePen, Heart, Settings } from "lucide-react";
import { clearTokens } from "@/lib/auth";
import { SettingsDialog } from "@/components/settings-dialog";

interface User {
  id: number;
  username: string;
  permalink: string;
  avatar_url: string | null;
}

const NAV_LINKS = [
  { href: "/meta-editor", label: "Meta Editor", icon: FilePen },
  { href: "/like-explorer", label: "Like Explorer", icon: Heart },
];

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    try {
      const stored = localStorage.getItem("sc_user");
      if (stored) setUser(JSON.parse(stored));
    } catch {
      // ignore malformed data
    }
  }, []);

  function handleDisconnect() {
    clearTokens();
    setUser(null);
    router.push("/");
  }

  return (
    <aside className="group/sidebar fixed left-0 top-0 bottom-0 z-50 flex flex-col bg-card border-r border-border/50 w-14 hover:w-52 transition-[width] duration-200 ease-in-out overflow-hidden shrink-0">
      {/* Logo */}
      <div className="h-14 flex items-center px-4 shrink-0 border-b border-border/50">
        <Link href="/" className="flex items-center gap-3 min-w-0">
          <span
            className="size-6 shrink-0 bg-primary"
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
          <span className="text-sm font-bold tracking-tight text-primary opacity-0 group-hover/sidebar:opacity-100 transition-opacity duration-150 whitespace-nowrap overflow-hidden">
            Starlib
          </span>
        </Link>
      </div>

      {/* Nav links */}
      <nav className="flex-1 py-3 flex flex-col gap-0.5 px-2">
        {NAV_LINKS.map(({ href, label, icon: Icon }) => {
          const active = pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              title={label}
              className={`flex items-center gap-3 px-2 py-2 rounded-md transition-colors ${
                active
                  ? "text-primary bg-primary/10"
                  : "text-muted-foreground hover:text-foreground hover:bg-accent/50"
              }`}
            >
              <span className="w-6 shrink-0 flex items-center justify-center">
                <Icon className="size-4" />
              </span>
              <span className="text-xs font-medium tracking-wide opacity-0 group-hover/sidebar:opacity-100 transition-opacity duration-150 whitespace-nowrap overflow-hidden">
                {label}
              </span>
            </Link>
          );
        })}
      </nav>

      {/* Settings */}
      <div className="px-2 pb-1 shrink-0">
        <button
          onClick={() => setSettingsOpen(true)}
          title="Settings"
          className="w-full flex items-center gap-3 px-2 py-2 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors cursor-pointer"
        >
          <span className="w-6 shrink-0 flex items-center justify-center">
            <Settings className="size-4" />
          </span>
          <span className="text-xs opacity-0 group-hover/sidebar:opacity-100 transition-opacity duration-150 whitespace-nowrap overflow-hidden">
            Settings
          </span>
        </button>
      </div>

      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />

      {/* User / disconnect */}
      <div className="border-t border-border/50 px-2 py-3 shrink-0">
        {user ? (
          <button
            onClick={handleDisconnect}
            title="Disconnect"
            className="w-full flex items-center gap-3 px-2 py-2 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
          >
            {user.avatar_url ? (
              <span className="w-6 shrink-0 flex items-center justify-center">
                <img
                  src={user.avatar_url}
                  alt={user.username}
                  className="size-5 rounded-full object-cover"
                />
              </span>
            ) : (
              <span className="w-6 shrink-0 flex items-center justify-center">
              <div className="size-5 rounded-full bg-primary/20 flex items-center justify-center text-[9px] font-bold text-primary">
                {user.username.slice(0, 1).toUpperCase()}
              </div>
              </span>
            )}
            <span className="text-xs opacity-0 group-hover/sidebar:opacity-100 transition-opacity duration-150 whitespace-nowrap overflow-hidden">
              Disconnect
            </span>
          </button>
        ) : (
          <Link
            href="/auth/login"
            title="Connect SoundCloud"
            className="w-full flex items-center gap-3 px-2 py-2 rounded-md text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors"
          >
            <span className="w-6 shrink-0 flex items-center justify-center">
              <Music2 className="size-4" />
            </span>
            <span className="text-xs opacity-0 group-hover/sidebar:opacity-100 transition-opacity duration-150 whitespace-nowrap overflow-hidden">
              Connect SC
            </span>
          </Link>
        )}
      </div>
    </aside>
  );
}
