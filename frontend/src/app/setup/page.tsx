"use client";

import { type FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
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
      setError(err instanceof Error ? err.message : "Failed to save configuration.");
      setLoading(false);
    }
  }

  return (
    <div className="flex justify-center py-20 px-6">
      <div className="max-w-lg w-full">
        <div className="mb-10">
          <h1 className="text-3xl font-bold tracking-tight mb-2">Welcome to SoundCloud Tools</h1>
          <p className="text-muted-foreground">
            To get started, you need to register a SoundCloud app and enter your credentials below.
            Your credentials are stored locally on this machine and never shared.
          </p>
        </div>

        <div className="bg-card border border-border rounded-xl p-6 mb-6">
          <h2 className="font-semibold mb-1">How to get your credentials</h2>
          <ol className="text-sm text-muted-foreground space-y-1 list-decimal list-inside">
            <li>
              Go to{" "}
              <a
                href="https://soundcloud.com/you/apps"
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-2 hover:text-foreground"
              >
                soundcloud.com/you/apps
              </a>{" "}
              and register a new application.
            </li>
            <li>Set the redirect URI to: <code className="bg-muted px-1 rounded text-xs">http://localhost:3000/auth/soundcloud/callback</code></li>
            <li>Copy the <strong>Client ID</strong> and <strong>Client Secret</strong> from the app page.</li>
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
            <p className="text-xs text-muted-foreground">
              The folder where your local music files are stored. Tilde (~) is expanded automatically.
            </p>
          </div>

          {error && (
            <p className="text-sm text-destructive">{error}</p>
          )}

          <Button type="submit" disabled={loading} className="w-full">
            {loading ? "Saving…" : "Save and get started"}
          </Button>
        </form>
      </div>
    </div>
  );
}
