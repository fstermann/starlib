import { SoundCloudLogo } from "@/components/icons/soundcloud-logo";
import * as sc from "@/lib/soundcloud";
import type { SCTrack } from "@/lib/soundcloud";

import type { MusicSource, SourceMetadata, SourceTrack } from "./types";

function toSourceTrack(track: SCTrack): SourceTrack {
  return {
    id: String(track.urn?.split(":").pop() ?? ""),
    title: track.title ?? undefined,
    artwork_url: track.artwork_url ?? undefined,
    permalink_url: track.permalink_url ?? undefined,
    username: track.user?.username ?? undefined,
    genre: track.genre ?? undefined,
    raw: track,
  };
}

function extractMetadata(track: SourceTrack): SourceMetadata {
  const raw = track.raw as SCTrack;

  let releaseDate: string | undefined;
  if (raw.release_year && raw.release_year > 0) {
    const m =
      raw.release_month && raw.release_month > 0 ? raw.release_month : 1;
    const d = raw.release_day && raw.release_day > 0 ? raw.release_day : 1;
    releaseDate = `${raw.release_year}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  } else if (raw.created_at) {
    const normalized = raw.created_at
      .replace(/\//g, "-")
      .replace(" ", "T")
      .replace(" +0000", "Z");
    const date = new Date(normalized);
    if (!isNaN(date.getTime())) {
      releaseDate = date.toISOString().slice(0, 10);
    }
  }

  // Use HQ artwork (SoundCloud serves large artwork as -large, t500x500 is the HQ version)
  const artworkUrl = raw.artwork_url
    ? raw.artwork_url.replace("-large", "-t500x500")
    : undefined;

  const permalink = raw.permalink_url
    ? (() => {
        try {
          const u = new URL(raw.permalink_url!);
          return `${u.origin}${u.pathname}`;
        } catch {
          return raw.permalink_url ?? "";
        }
      })()
    : "";

  return {
    title: raw.title ?? undefined,
    artist: raw.user?.username ?? undefined,
    genre: raw.genre ?? undefined,
    release_date: releaseDate,
    artwork_url: artworkUrl,
    source_id: track.id,
    source_permalink: permalink,
  };
}

export const soundCloudSource: MusicSource = {
  id: "soundcloud",
  name: "SoundCloud",
  Icon: SoundCloudLogo,

  async searchTracks(query: string): Promise<SourceTrack[]> {
    const tracks = await sc.searchTracks(query);
    return tracks.map(toSourceTrack);
  },

  async resolveUrl(url: string): Promise<SourceTrack | null> {
    const result = await sc.resolveUrl(url);
    if (!result || !("title" in result)) return null;
    return toSourceTrack(result as SCTrack);
  },

  extractMetadata,

  getEmbedUrl(track: SourceTrack, isDark: boolean): string | null {
    if (!track.permalink_url) return null;
    const color = isDark ? "#d0fd5a" : "#bde752";
    const params = new URLSearchParams({
      url: track.permalink_url,
      color,
      auto_play: "false",
      hide_related: "true",
      show_comments: "false",
      show_user: "true",
      show_reposts: "false",
      show_teaser: "false",
      visual: "true",
    });
    return `https://w.soundcloud.com/player/?${params.toString()}`;
  },
};
