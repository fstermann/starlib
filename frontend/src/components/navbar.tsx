"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

interface User {
  id: number;
  username: string;
  permalink: string;
  avatar_url: string | null;
}

const NAV_LINKS = [{ href: "/meta-editor", label: "Meta Editor" }];

export function Navbar() {
  const pathname = usePathname();
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);

  useEffect(() => {
    try {
      const stored = localStorage.getItem("sc_user");
      if (stored) setUser(JSON.parse(stored));
    } catch {
      // ignore malformed data
    }
  }, []);

  function handleDisconnect() {
    localStorage.removeItem("access_token");
    localStorage.removeItem("sc_user");
    setUser(null);
    router.push("/");
  }

  return (
    <header className="sticky top-0 z-50 border-b border-zinc-200 dark:border-zinc-800 bg-white/95 dark:bg-black/95 backdrop-blur supports-[backdrop-filter]:bg-white/80 dark:supports-[backdrop-filter]:bg-black/80">
      <div className="max-w-6xl mx-auto px-6 h-14 flex items-center gap-8">
        <Link
          href="/"
          className="font-semibold text-sm text-zinc-900 dark:text-zinc-100 hover:opacity-80 transition-opacity shrink-0"
        >
          SoundCloud Tools
        </Link>

        <nav className="flex items-center gap-1 flex-1">
          {NAV_LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className={`px-3 py-1.5 rounded-md text-sm transition-colors ${
                pathname.startsWith(link.href)
                  ? "bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 font-medium"
                  : "text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-100 dark:hover:bg-zinc-800"
              }`}
            >
              {link.label}
            </Link>
          ))}
        </nav>

        <div className="flex items-center gap-3 shrink-0">
          {user ? (
            <>
              <span className="text-sm text-zinc-500 dark:text-zinc-400 hidden sm:block">
                {user.username}
              </span>
              <Button variant="outline" size="sm" onClick={handleDisconnect}>
                Disconnect
              </Button>
            </>
          ) : (
            <Button asChild size="sm">
              <Link href="/auth/login">Connect SoundCloud</Link>
            </Button>
          )}
        </div>
      </div>
    </header>
  );
}
