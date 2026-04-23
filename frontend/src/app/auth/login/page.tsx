"use client";

import { invoke } from "@tauri-apps/api/core";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { fetchApi } from "@/lib/api";
import { storeTokens } from "@/lib/auth";
import { isTauri } from "@/lib/tauri";

interface CapturedAuth {
  oauth_token: string | null;
  completed: boolean;
}

interface AuthorizeResponse {
  authorization_url: string;
  state: string;
}

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

const POLL_INTERVAL_MS = 1500;
const POLL_JITTER_MS = 200;
const POLL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/** Sleep that clears its timeout when the signal aborts — without this a
 * fired-and-forgotten setTimeout keeps a ref to the callback (and its closure)
 * until the natural interval elapses, which is a leak on navigate-away. */
function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Poll /auth/soundcloud/result until the browser-side redirect delivers it,
 * or we time out. Returns the tokens on success; throws on timeout / abort.
 * Adds ±POLL_JITTER_MS jitter so N simultaneous logins don't align into a
 * tight request train (pairs with the backend rate limiter). */
async function pollForOAuthResult(
  state: string,
  abort: AbortController,
): Promise<CallbackResponse> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (abort.signal.aborted) throw new Error("Login cancelled");
    try {
      const result = await fetchApi<CallbackResponse>(
        `/auth/soundcloud/result?state=${encodeURIComponent(state)}`,
        { signal: abort.signal },
      );
      return result;
    } catch (err) {
      // 404 = not yet available, keep polling. Anything else bubbles up.
      const anyErr = err as { status?: number };
      if (anyErr?.status !== 404) throw err;
    }
    const jitter = (Math.random() * 2 - 1) * POLL_JITTER_MS;
    await abortableSleep(Math.max(0, POLL_INTERVAL_MS + jitter), abort.signal);
  }
  throw new Error("Login timed out. Please try again.");
}

export default function LoginPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Abort any in-flight poll when the component unmounts (e.g. user navigates
  // away) so the setTimeout chain in pollForOAuthResult clears immediately.
  useEffect(() => () => abortRef.current?.abort(), []);

  async function handleConnect() {
    setLoading(true);
    setError(null);
    abortRef.current?.abort();
    const abort = new AbortController();
    abortRef.current = abort;

    try {
      const inTauri = isTauri();
      // In Tauri we poll for the result from this window — browser just lands
      // on a static "you can close this tab" page. In a plain browser, let
      // the existing callback page handle it.
      const returnTo = inTauri
        ? "http://127.0.0.1:8000/auth/soundcloud/done"
        : `${window.location.origin}/auth/soundcloud/callback`;
      const data = await fetchApi<AuthorizeResponse>(
        `/auth/soundcloud/authorize?return_to=${encodeURIComponent(returnTo)}`,
      );
      sessionStorage.setItem("oauth_state", data.state);

      if (inTauri) {
        // Open SoundCloud's authorize URL in an in-app webview so we can
        // ALSO harvest the api-v2 web-session `oauth_token` cookie on the
        // way out — that cookie is required to reach system-playlist
        // endpoints (Mixes). The backend code exchange still happens
        // server-side via the existing /redirect handler, same as before.
        const captured = await invoke<CapturedAuth>("open_soundcloud_login", {
          authUrl: data.authorization_url,
        });
        if (!captured.completed) throw new Error("Login cancelled");

        const result = await pollForOAuthResult(data.state, abort);
        storeTokens(
          result.access_token,
          result.refresh_token,
          result.expires_in,
        );
        localStorage.setItem("sc_user", JSON.stringify(result.user));
        sessionStorage.removeItem("oauth_state");

        // Best-effort: persist the captured session cookie. If this 422s
        // (unexpected token shape) or the webview didn't expose the cookie,
        // Mixes stays hidden but the rest of SoundCloud still works.
        if (captured.oauth_token) {
          try {
            await fetchApi("/auth/soundcloud/session-cookie", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ oauth_token: captured.oauth_token }),
            });
          } catch (err) {
            console.warn("session-cookie persist failed:", err);
          }
        }

        window.dispatchEvent(new Event("auth-changed"));
        router.push("/library?source=soundcloud");
      } else {
        window.location.href = data.authorization_url;
      }
    } catch (err) {
      if ((err as Error)?.name !== "AbortError") {
        setError(
          err instanceof Error ? err.message : "Failed to initiate login",
        );
      }
    } finally {
      setLoading(false);
    }
  }

  function handleCancel() {
    abortRef.current?.abort();
    setLoading(false);
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
            {loading ? "Waiting for SoundCloud…" : "Connect with SoundCloud"}
          </Button>

          {loading && (
            <button
              onClick={handleCancel}
              className="text-muted-foreground hover:text-foreground mt-3 text-xs"
            >
              Cancel
            </button>
          )}

          {error && <p className="text-destructive mt-4 text-sm">{error}</p>}
        </div>
      </div>
    </div>
  );
}
