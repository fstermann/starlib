import { api, type FilterValues } from "@/lib/api";
import type { FilterSchemaResponse, FilterState } from "@/lib/filters/schema";

export interface FilesystemSchemaInputs {
  /** Folder mode (e.g. "prepare", "collection"). Used when folderPath is undefined. */
  mode?: string;
  /** Absolute folder path. When set, takes precedence over mode. */
  folderPath?: string;
  /** Current filter state (for dependent counts). */
  state: FilterState;
}

/**
 * Calls the existing /filter-values endpoint and adapts FilterValuesResponse
 * into the unified FilterSchemaResponse shape. When the backend grows a
 * dedicated /filters/schema/filesystem endpoint, replace the fetch call —
 * the produced shape stays identical.
 */
export async function fetchFilesystemSchema(
  inputs: FilesystemSchemaInputs,
): Promise<FilterSchemaResponse> {
  const params = paramsFromState(inputs.state);
  const values: FilterValues = inputs.folderPath
    ? await api.getPathFilterValues(inputs.folderPath, {
        ...params,
        recursive: true,
      })
    : await api.getFilterValues(inputs.mode ?? "prepare", params);
  return adapt(values);
}

function paramsFromState(state: FilterState) {
  const search = state.search as string | undefined;
  const genres = (state.genre as string[] | undefined) ?? [];
  const keys = (state.key as string[] | undefined) ?? [];
  const bpm = (state.bpm as [number | null, number | null] | undefined) ?? [
    null,
    null,
  ];
  const fileFormats = (state.file_format as string[] | undefined) ?? [];
  const size = (state.file_size as
    | [number | null, number | null]
    | undefined) ?? [null, null];
  return {
    search: search || undefined,
    genres: genres.length ? genres : undefined,
    keys: keys.length ? keys : undefined,
    bpmMin: bpm[0] ?? undefined,
    bpmMax: bpm[1] ?? undefined,
    fileFormats: fileFormats.length ? fileFormats : undefined,
    sizeMin: size[0] ?? undefined,
    sizeMax: size[1] ?? undefined,
  };
}

function adapt(values: FilterValues): FilterSchemaResponse {
  const bpmMin = values.bpm_min ?? null;
  const bpmMax = values.bpm_max ?? null;
  const hasBpm = bpmMin !== null && bpmMax !== null && bpmMax > bpmMin;
  const sizeMin = values.file_size_min ?? null;
  const sizeMax = values.file_size_max ?? null;
  const hasSize = sizeMin !== null && sizeMax !== null && sizeMax > sizeMin;
  return {
    source: "filesystem",
    attributes: [
      { id: "search", label: "Search", kind: "text" },
      {
        id: "genre",
        label: "Genre",
        kind: "enum",
        options: values.genres,
        counts: values.genre_counts,
      },
      {
        id: "key",
        label: "Key",
        kind: "enum",
        sortHint: "camelot",
        options: values.keys,
        counts: values.key_counts,
      },
      ...(hasBpm
        ? [
            {
              id: "bpm",
              label: "BPM",
              kind: "range" as const,
              min: bpmMin!,
              max: bpmMax!,
              step: 1,
            },
          ]
        : []),
      {
        id: "file_format",
        label: "Format",
        kind: "enum",
        options: values.file_formats ?? [],
        counts: values.file_format_counts,
      },
      ...(hasSize
        ? [
            {
              id: "file_size",
              label: "Size",
              kind: "range" as const,
              min: sizeMin!,
              max: sizeMax!,
              // Bucket the slider so the UX doesn't try to scrub byte-by-byte.
              // Pick ~100 steps across the range, rounded to a friendly unit.
              step: stepFor(sizeMin!, sizeMax!),
              formatHint: "size" as const,
            },
          ]
        : []),
      { id: "soundcloud_linked", label: "SoundCloud", kind: "bool" as const },
    ],
  };
}

function stepFor(min: number, max: number): number {
  const span = max - min;
  if (span <= 1024 * 1024) return 1024; // KB-scale
  if (span <= 100 * 1024 * 1024) return 100 * 1024; // 100 KB
  return 1024 * 1024; // 1 MB
}
