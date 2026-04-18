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
    localStorage.removeItem("access_token");
    localStorage.removeItem("sc_user");
    setUser(null);
    router.push("/");
  }

  return (
    <header className="bg-card/95 sticky top-0 z-50 shrink-0 backdrop-blur-xl">
      <div className="flex h-12 items-center gap-6 px-5">
        <Link
          href="/"
          className="text-primary shrink-0 text-sm font-bold tracking-tight transition-opacity hover:opacity-75"
        >
          Starlib
        </Link>

        <nav className="flex flex-1 items-center gap-0.5">
          {NAV_LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className={`rounded px-3 py-1 text-xs font-medium tracking-wide transition-colors ${
                pathname.startsWith(link.href)
                  ? "text-primary bg-brand-soft"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {link.label}
            </Link>
          ))}
        </nav>

        <div className="flex shrink-0 items-center gap-2">
          {user ? (
            <>
              <span className="text-muted-foreground hidden font-mono text-xs sm:block">
                {user.username}
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs"
                onClick={handleDisconnect}
              >
                Disconnect
              </Button>
            </>
          ) : (
            <Button asChild size="sm" className="h-7 text-xs">
              <Link href="/auth/login">Connect SoundCloud</Link>
            </Button>
          )}
        </div>
      </div>
      <div className="via-primary/40 h-px bg-gradient-to-r from-transparent to-transparent" />
    </header>
  );
}
