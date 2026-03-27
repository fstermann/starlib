import {
  parseAsArrayOf,
  parseAsInteger,
  parseAsString,
  parseAsStringLiteral,
} from 'nuqs';

export const FOLDER_MODES = ['prepare', 'collection', 'cleaned'] as const;
export const VIEW_MODES = ['edit', 'view'] as const;
export const SORT_FIELDS = ['title', 'artist', 'genre', 'bpm', 'key', 'release_date', 'file_name'] as const;
export const SORT_ORDERS = ['asc', 'desc'] as const;

export type FolderMode = (typeof FOLDER_MODES)[number];
export type ViewMode = (typeof VIEW_MODES)[number];
export type SortField = (typeof SORT_FIELDS)[number];
export type SortOrder = (typeof SORT_ORDERS)[number];

/** URL param parsers for all shareable page state. */
export const searchParams = {
  mode: parseAsStringLiteral(FOLDER_MODES).withDefault('prepare'),
  view: parseAsStringLiteral(VIEW_MODES).withDefault('edit'),
  search: parseAsString.withDefault(''),
  genres: parseAsArrayOf(parseAsString).withDefault([]),
  keys: parseAsArrayOf(parseAsString).withDefault([]),
  bpmMin: parseAsInteger,
  bpmMax: parseAsInteger,
  sort: parseAsStringLiteral(SORT_FIELDS).withDefault('file_name'),
  order: parseAsStringLiteral(SORT_ORDERS).withDefault('asc'),
};
