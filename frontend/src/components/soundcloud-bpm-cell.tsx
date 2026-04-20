"use client";

import { Loader2, Waves } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { analyzeScBpm, isTauri } from "@/lib/tauri";

interface Props {
  trackId: number;
  /** SoundCloud-metadata BPM from the track object; often null for user uploads. */
  metadataBpm: number | null | undefined;
}

/** BPM cell for SoundCloud library rows.
 *
 * Precedence: locally-computed cached BPM (this session) > backend-cached
 * BPM (set by a previous analyze) > metadata-supplied BPM > "Detect" button.
 *
 * On click: fetches a Client-Credentials token from the backend, invokes the
 * Rust BPM command via Tauri, persists the result to the cache DB, and
 * shows the new value. Hidden outside the Tauri WebView.
 */
export function SoundcloudBpmCell({ trackId, metadataBpm }: Props) {
  const [analyzedBpm, setAnalyzedBpm] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);

  const displayBpm = analyzedBpm ?? metadataBpm ?? null;

  async function handleAnalyze() {
    if (!isTauri() || !trackId || loading) return;
    setLoading(true);
    try {
      const { token } = await api.getSoundcloudClientToken();
      const result = await analyzeScBpm(trackId, token);
      const rounded = Math.round(result.bpm);
      await api.saveSoundcloudBpm(trackId, result.bpm);
      setAnalyzedBpm(rounded);
      toast.success(
        `Detected ${rounded} BPM (${result.confidence} confidence)`,
      );
    } catch (err) {
      toast.error(
        `BPM detection failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setLoading(false);
    }
  }

  if (displayBpm != null) {
    return <>{displayBpm}</>;
  }
  if (!isTauri()) {
    return <>—</>;
  }
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      onClick={handleAnalyze}
      disabled={loading}
      title="Detect BPM"
    >
      {loading ? <Loader2 className="animate-spin" /> : <Waves />}
    </Button>
  );
}
