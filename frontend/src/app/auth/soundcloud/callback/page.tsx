"use client";

import { useEffect, useState, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";
import { fetchApi } from "@/lib/api";

interface UserInfo {
  id: number;
  username: string;
  permalink: string;
  avatar_url: string | null;
}

interface CallbackResponse {
  access_token: string;
  refresh_token: string | null;
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

    const codeVerifier = sessionStorage.getItem("oauth_code_verifier");
    if (!codeVerifier) {
      setError("Missing PKCE code verifier. Please try connecting again.");
      return;
    }

    sessionStorage.removeItem("oauth_state");
    sessionStorage.removeItem("oauth_code_verifier");

    fetchApi<CallbackResponse>("/auth/soundcloud/callback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, state, code_verifier: codeVerifier }),
    })
      .then((data) => {
        localStorage.setItem("access_token", data.access_token);
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
        <p className="text-red-500 dark:text-red-400 mb-4 text-sm">{error}</p>
        <Link
          href="/auth/login"
          className="text-sm text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100"
        >
          Try again
        </Link>
      </div>
    );
  }

  return (
    <div className="text-center">
      <div className="w-6 h-6 border-2 border-zinc-300 dark:border-zinc-600 border-t-zinc-900 dark:border-t-zinc-100 rounded-full animate-spin mx-auto mb-4" />
      <p className="text-zinc-500 dark:text-zinc-400 text-sm">Authenticating…</p>
    </div>
  );
}

export default function CallbackPage() {
  return (
    <div className="flex justify-center py-20 px-6">
      <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg p-8">
        <Suspense
          fallback={
            <div className="text-center">
              <div className="w-6 h-6 border-2 border-zinc-300 dark:border-zinc-600 border-t-zinc-900 dark:border-t-zinc-100 rounded-full animate-spin mx-auto mb-4" />
              <p className="text-zinc-500 dark:text-zinc-400 text-sm">Loading…</p>
            </div>
          }
        >
          <CallbackHandler />
        </Suspense>
      </div>
    </div>
  );
}
