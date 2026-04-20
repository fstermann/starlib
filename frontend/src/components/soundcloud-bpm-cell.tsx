"use client";

import { Loader2, Waves } from "lucide-react";
import React, { useContext, useEffect, useState } from "react";
import { toast } from "sonner";

import {
  SC_BPM_UPDATED_EVENT,
  type ScBpmUpdatedDetail,
} from "@/components/soundcloud-batch-analyze-button";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { analyzeScBpm, isTauri } from "@/lib/tauri";

interface Props {
  trackId: number;
  /** SoundCloud-metadata BPM from the track object; often null for user uploads. */
  metadataBpm: number | null | undefined;
}

/** Lookup table of track_id → cached BPM, provided by the table that pre-fills
 * the page's visible rows in one bulk call (see likes-table.tsx). A null value
 * means "pre-fill attempted but no row in the cache"; an entry missing
 * entirely means pre-fill hasn't resolved yet. */
export const SoundcloudBpmCacheContext = React.createContext<
  Map<number, number>
>(new Map());

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
  const bpmCache = useContext(SoundcloudBpmCacheContext);

  const cachedBpm = bpmCache.get(trackId);
  const displayBpm = analyzedBpm ?? cachedBpm ?? metadataBpm ?? null;

  // Listen for batch-analyze results so visible rows fill in live.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<ScBpmUpdatedDetail>).detail;
      if (detail?.trackId === trackId) {
        setAnalyzedBpm(detail.bpm);
      }
    };
    window.addEventListener(SC_BPM_UPDATED_EVENT, handler);
    return () => window.removeEventListener(SC_BPM_UPDATED_EVENT, handler);
  }, [trackId]);

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
