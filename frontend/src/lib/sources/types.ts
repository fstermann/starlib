import type { ComponentType, CSSProperties } from "react";

/**
 * Common track representation shared by all music sources.
 * Source-specific data is kept in `raw`.
 */
export interface SourceTrack {
  /** Unique ID within the source (numeric or string). */
  id: string;
  title?: string;
  /** Thumbnail URL used for list/preview display. */
  artwork_url?: string;
  /** Link to the track on the source's website. */
  permalink_url?: string;
  /** Primary artist / uploader name. */
  username?: string;
  genre?: string;
  /** Original source-specific data. Cast to the appropriate type in the source adapter. */
  raw: unknown;
}

/**
 * Extracted, normalised metadata ready to apply to a local track.
 * `source_id` and `source_permalink` identify the linked remote track.
 */
export interface SourceMetadata {
  title?: string;
  artist?: string;
  genre?: string;
  release_date?: string;
  /** High-quality artwork URL suitable for saving as embedded artwork. */
  artwork_url?: string;
  source_id: string;
  source_permalink: string;
}

/**
 * Interface that every music source adapter must implement.
 * Adding a new source means creating a new object that satisfies this interface.
 */
export interface MusicSource {
  /** Machine-readable identifier (e.g. "soundcloud"). */
  id: string;
  /** Human-readable display name (e.g. "SoundCloud"). */
  name: string;
  /** Brand icon component. Accepts a `className` and `style` prop for sizing/colouring. */
  Icon: ComponentType<{ className?: string; style?: CSSProperties }>;
  /** Search tracks by text query. */
  searchTracks(query: string): Promise<SourceTrack[]>;
  /** Resolve a source URL to a single track, or null if not resolvable. */
  resolveUrl(url: string): Promise<SourceTrack | null>;
  /** Extract normalised metadata from a track (including HQ artwork URL). */
  extractMetadata(track: SourceTrack): SourceMetadata;
  /**
   * Return an iframe src URL for an embedded player, or null if unsupported.
   * `isDark` lets the source pick an appropriate theme colour.
   */
  getEmbedUrl(track: SourceTrack, isDark: boolean): string | null;
}
