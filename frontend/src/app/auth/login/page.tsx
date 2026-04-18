"use client";

import { open as openExternal } from "@tauri-apps/plugin-shell";
import Link from "next/link";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { fetchApi } from "@/lib/api";
import { isTauri } from "@/lib/tauri";

interface AuthorizeResponse {
  authorization_url: string;
  state: string;
}

export default function LoginPage() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleConnect() {
    setLoading(true);
    setError(null);

    try {
      const inTauri = isTauri();
      const returnTo = inTauri
        ? "starlib://localhost/auth/soundcloud/callback"
        : `${window.location.origin}/auth/soundcloud/callback`;
      const data = await fetchApi<AuthorizeResponse>(
        `/auth/soundcloud/authorize?return_to=${encodeURIComponent(returnTo)}`,
      );
      sessionStorage.setItem("oauth_state", data.state);
      if (inTauri) {
        await openExternal(data.authorization_url);
        setLoading(false);
      } else {
        window.location.href = data.authorization_url;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to initiate login");
      setLoading(false);
    }
  }

  return (
    <div className="flex justify-center px-6 py-20">
      <div className="w-full max-w-md">
        <div className="bg-card border-border shadow-primary/5 rounded-xl border p-8 text-center shadow-lg">
          <h1 className="text-card-foreground mb-2 text-2xl font-semibold">
            Connect SoundCloud
          </h1>
          <p className="text-muted-foreground mb-8 text-sm">
            Authorize Starlib to access your SoundCloud account.
          </p>

          <Button onClick={handleConnect} disabled={loading} className="w-full">
            {loading ? "Opening…" : "Connect with SoundCloud"}
          </Button>

          {error && <p className="text-destructive mt-4 text-sm">{error}</p>}
        </div>
      </div>
    </div>
  );
}
