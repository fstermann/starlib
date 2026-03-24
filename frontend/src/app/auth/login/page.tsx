"use client";

import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { fetchApi } from "@/lib/api";

interface AuthorizeResponse {
  authorization_url: string;
  state: string;
  code_verifier: string;
}

export default function LoginPage() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleConnect() {
    setLoading(true);
    setError(null);

    try {
      const data = await fetchApi<AuthorizeResponse>("/auth/soundcloud/authorize");
      sessionStorage.setItem("oauth_state", data.state);
      sessionStorage.setItem("oauth_code_verifier", data.code_verifier);
      window.location.href = data.authorization_url;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to initiate login");
      setLoading(false);
    }
  }

  return (
    <div className="flex justify-center py-20 px-6">
      <div className="max-w-md w-full">

        <div className="bg-card border border-border rounded-xl p-8 text-center shadow-lg shadow-primary/5">
          <h1 className="text-2xl font-semibold text-card-foreground mb-2">
            Connect SoundCloud
          </h1>
          <p className="text-muted-foreground mb-8 text-sm">
            Authorize Starlib to access your SoundCloud account.
          </p>

          <Button
            onClick={handleConnect}
            disabled={loading}
            className="w-full"
          >
            {loading ? "Redirecting…" : "Connect with SoundCloud"}
          </Button>

          {error && (
            <p className="mt-4 text-sm text-destructive">{error}</p>
          )}
        </div>
      </div>
    </div>
  );
}
