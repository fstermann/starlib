import { parseAsString, parseAsStringLiteral } from "nuqs";

/** Legacy constant kept for reference; tabs are now driven by the folder config API. */
export const FOLDER_MODES = ["prepare", "collection", "cleaned"] as const;
export const SORT_FIELDS = [
  "title",
  "artist",
  "genre",
  "bpm",
  "key",
  "release_date",
  "file_name",
  "folder",
  "mtime",
  "file_format",
  "file_size",
  "duration",
] as const;
export const SORT_ORDERS = ["asc", "desc"] as const;

export type FolderMode = string;
export type SortField = (typeof SORT_FIELDS)[number];
export type SortOrder = (typeof SORT_ORDERS)[number];

/**
 * Non-filter URL params. Filter params (search, genre, key, bpmMin, bpmMax,
 * etc.) are derived from the filter schema at runtime via `useFilterState`.
 */
export const searchParams = {
  mode: parseAsString.withDefault("prepare"),
  nodeId: parseAsString.withDefault(""),
  sort: parseAsStringLiteral(SORT_FIELDS).withDefault("mtime"),
  order: parseAsStringLiteral(SORT_ORDERS).withDefault("desc"),
};
