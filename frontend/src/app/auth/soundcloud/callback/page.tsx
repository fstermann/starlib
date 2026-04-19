"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";

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
  const exchanged = useRef(false);

  /* eslint-disable react-hooks/set-state-in-effect --
     OAuth callback: one-shot side effect on mount, guarded by exchanged ref.
     setError paths are terminal (no cascading renders). */
  useEffect(() => {
    if (exchanged.current) return;
    exchanged.current = true;

    const code = searchParams.get("code");
    const state = searchParams.get("state");
    const errorParam = searchParams.get("error");

    if (errorParam) {
      setError(`SoundCloud denied access: ${errorParam}`);
      return;
    }

    if (!state) {
      setError("Missing state in callback URL.");
      return;
    }

    const handleSuccess = (data: CallbackResponse) => {
      storeTokens(data.access_token, data.refresh_token, data.expires_in);
      localStorage.setItem("sc_user", JSON.stringify(data.user));
      sessionStorage.removeItem("oauth_state");
      window.dispatchEvent(new Event("auth-changed"));
      router.push("/library?source=soundcloud");
    };

    const handleError = (err: unknown) => {
      setError(err instanceof Error ? err.message : "Authentication failed.");
    };

    if (code) {
      // Direct SoundCloud callback: verify state, exchange code for tokens
      const storedState = sessionStorage.getItem("oauth_state");
      if (state !== storedState) {
        setError("State mismatch. Possible CSRF attack.");
        return;
      }
      fetchApi<CallbackResponse>("/auth/soundcloud/callback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, state }),
      })
        .then(handleSuccess)
        .catch(handleError);
    } else {
      // Backend-redirect flow: tokens already exchanged server-side
      fetchApi<CallbackResponse>(`/auth/soundcloud/result?state=${state}`)
        .then(handleSuccess)
        .catch(handleError);
    }
  }, [searchParams, router]);
  /* eslint-enable react-hooks/set-state-in-effect */

  if (error) {
    return (
      <div className="text-center">
        <p className="text-destructive mb-4 text-sm">{error}</p>
        <Link
          href="/auth/login"
          className="text-muted-foreground hover:text-foreground text-sm"
        >
          Try again
        </Link>
      </div>
    );
  }

  return (
    <div className="text-center">
      <div className="border-border border-t-foreground mx-auto mb-4 size-6 animate-spin rounded-full border-2" />
      <p className="text-muted-foreground text-sm">Authenticating…</p>
    </div>
  );
}

export default function CallbackPage() {
  return (
    <div className="flex justify-center px-6 py-20">
      <div className="bg-card border-border shadow-primary/5 rounded-xl border p-8 shadow-lg">
        <Suspense
          fallback={
            <div className="text-center">
              <div className="border-border border-t-foreground mx-auto mb-4 size-6 animate-spin rounded-full border-2" />
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
