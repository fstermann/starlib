"use client";

import { useEffect, useState, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";
import { fetchApi } from "@/lib/api";
import { storeTokens } from "@/lib/auth";

interface UserInfo {
  id: number;
  username: string;
  permalink: string;
  avatar_url: string | null;
}

interface CallbackResponse {
  access_token: string;
  refresh_token: string | null;
  expires_in: number | null;
  user: UserInfo;
}

function CallbackHandler() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const code = searchParams.get("code");
    const state = searchParams.get("state");
    const errorParam = searchParams.get("error");

    if (errorParam) {
      setError(`SoundCloud denied access: ${errorParam}`);
      return;
    }

    if (!code || !state) {
      setError("Missing code or state in callback URL.");
      return;
    }

    const storedState = sessionStorage.getItem("oauth_state");
    if (state !== storedState) {
      setError("State mismatch. Possible CSRF attack.");
      return;
    }

    sessionStorage.removeItem("oauth_state");

    fetchApi<CallbackResponse>("/auth/soundcloud/callback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, state }),
    })
      .then((data) => {
        storeTokens(data.access_token, data.refresh_token, data.expires_in);
        localStorage.setItem("sc_user", JSON.stringify(data.user));
        router.push("/meta-editor");
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Authentication failed.");
      });
  }, [searchParams, router]);

  if (error) {
    return (
      <div className="text-center">
        <p className="text-destructive mb-4 text-sm">{error}</p>
        <Link
          href="/auth/login"
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          Try again
        </Link>
      </div>
    );
  }

  return (
    <div className="text-center">
      <div className="size-6 border-2 border-border border-t-foreground rounded-full animate-spin mx-auto mb-4" />
      <p className="text-muted-foreground text-sm">Authenticating…</p>
    </div>
  );
}

export default function CallbackPage() {
  return (
    <div className="flex justify-center py-20 px-6">
      <div className="bg-card border border-border rounded-xl p-8 shadow-lg shadow-primary/5">
        <Suspense
          fallback={
            <div className="text-center">
              <div className="size-6 border-2 border-border border-t-foreground rounded-full animate-spin mx-auto mb-4" />
              <p className="text-muted-foreground text-sm">Loading…</p>
            </div>
          }
        >
          <CallbackHandler />
        </Suspense>
      </div>
    </div>
  );
}
