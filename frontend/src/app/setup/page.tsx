"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";

export default function SetupPage() {
  const router = useRouter();
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [musicFolder, setMusicFolder] = useState("~/Music/tracks");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      await api.saveSetup({
        client_id: clientId.trim(),
        client_secret: clientSecret.trim(),
        root_music_folder: musicFolder.trim() || "~/Music/tracks",
      });
      // Redirect to home after successful setup.
      router.push("/");
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to save configuration.",
      );
      setLoading(false);
    }
  }

  return (
    <div className="flex justify-center px-6 py-20">
      <div className="w-full max-w-lg">
        <div className="mb-10">
          <h1 className="mb-2 text-3xl font-bold tracking-tight">
            Welcome to SoundCloud Tools
          </h1>
          <p className="text-muted-foreground">
            To get started, you need to register a SoundCloud app and enter your
            credentials below. Your credentials are stored locally on this
            machine and never shared.
          </p>
        </div>

        <div className="bg-card border-border mb-6 rounded-xl border p-6">
          <h2 className="mb-1 font-semibold">How to get your credentials</h2>
          <ol className="text-muted-foreground list-inside list-decimal space-y-1 text-sm">
            <li>
              Go to{" "}
              <a
                href="https://soundcloud.com/you/apps"
                target="_blank"
                rel="noreferrer"
                className="hover:text-foreground underline underline-offset-2"
              >
                soundcloud.com/you/apps
              </a>{" "}
              and register a new application.
            </li>
            <li>
              Set the redirect URI to:{" "}
              <code className="bg-muted rounded px-1 text-xs">
                http://127.0.0.1:8000/auth/soundcloud/redirect
              </code>
            </li>
            <li>
              Copy the <strong>Client ID</strong> and{" "}
              <strong>Client Secret</strong> from the app page.
            </li>
          </ol>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5">
          <div className="space-y-1.5">
            <Label htmlFor="client-id">Client ID</Label>
            <Input
              id="client-id"
              type="text"
              placeholder="Paste your SoundCloud Client ID"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              required
              autoComplete="off"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="client-secret">Client Secret</Label>
            <Input
              id="client-secret"
              type="password"
              placeholder="Paste your SoundCloud Client Secret"
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
              required
              autoComplete="off"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="music-folder">Music folder path</Label>
            <Input
              id="music-folder"
              type="text"
              placeholder="~/Music/tracks"
              value={musicFolder}
              onChange={(e) => setMusicFolder(e.target.value)}
            />
            <p className="text-muted-foreground text-xs">
              The folder where your local music files are stored. Tilde (~) is
              expanded automatically.
            </p>
          </div>

          {error && <p className="text-destructive text-sm">{error}</p>}

          <Button type="submit" disabled={loading} className="w-full">
            {loading ? "Saving…" : "Save and get started"}
          </Button>
        </form>
      </div>
    </div>
  );
}
