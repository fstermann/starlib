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
    <header className="sticky top-0 z-50 bg-card/95 backdrop-blur-xl shrink-0">
      <div className="px-5 h-12 flex items-center gap-6">
        <Link
          href="/"
          className="font-bold text-sm tracking-tight text-primary hover:opacity-75 transition-opacity shrink-0"
        >
          SoundCloud Tools
        </Link>

        <nav className="flex items-center gap-0.5 flex-1">
          {NAV_LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className={`px-3 py-1 rounded text-xs font-medium tracking-wide uppercase transition-colors ${
                pathname.startsWith(link.href)
                  ? "text-primary bg-primary/10"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {link.label}
            </Link>
          ))}
        </nav>

        <div className="flex items-center gap-2 shrink-0">
          {user ? (
            <>
              <span className="text-xs text-muted-foreground hidden sm:block font-mono">
                {user.username}
              </span>
              <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={handleDisconnect}>
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
      <div className="h-px bg-gradient-to-r from-transparent via-primary/40 to-transparent" />
    </header>
  );
}
