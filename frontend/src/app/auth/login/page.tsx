"use client";

import { open as openExternal } from "@tauri-apps/plugin-shell";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { fetchApi } from "@/lib/api";
import { storeTokens } from "@/lib/auth";
import { isTauri } from "@/lib/tauri";

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
const POLL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/** Poll /auth/soundcloud/result until the browser-side redirect delivers it,
 * or we time out. Returns the tokens on success; throws on timeout / abort. */
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
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error("Login timed out. Please try again.");
}

export default function LoginPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

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
        await openExternal(data.authorization_url);
        const result = await pollForOAuthResult(data.state, abort);
        storeTokens(
          result.access_token,
          result.refresh_token,
          result.expires_in,
        );
        localStorage.setItem("sc_user", JSON.stringify(result.user));
        sessionStorage.removeItem("oauth_state");
        window.dispatchEvent(new Event("auth-changed"));
        // Bring the Starlib window back to the front — the user is currently
        // looking at the "you can close this tab" page in their browser.
        // macOS throttles cross-app focus stealing hard; combine unminimize +
        // show + setFocus for best-effort activation, then bounce the dock
        // icon via requestUserAttention(Critical) which is explicitly
        // permitted for user-attention cues even when activation is refused.
        try {
          const { getCurrentWindow, UserAttentionType } =
            await import("@tauri-apps/api/window");
          const w = getCurrentWindow();
          await w.unminimize().catch(() => {});
          await w.show().catch(() => {});
          await w.setFocus().catch(() => {});
          await w
            .requestUserAttention(UserAttentionType.Critical)
            .catch(() => {});
        } catch (err) {
          console.warn("focus on self failed:", err);
        }
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
