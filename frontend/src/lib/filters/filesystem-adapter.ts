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
  return {
    search: search || undefined,
    genres: genres.length ? genres : undefined,
    keys: keys.length ? keys : undefined,
    bpmMin: bpm[0] ?? undefined,
    bpmMax: bpm[1] ?? undefined,
  };
}

function adapt(values: FilterValues): FilterSchemaResponse {
  const bpmMin = values.bpm_min ?? null;
  const bpmMax = values.bpm_max ?? null;
  const hasBpm = bpmMin !== null && bpmMax !== null && bpmMax > bpmMin;
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
      { id: "soundcloud_linked", label: "SoundCloud", kind: "bool" as const },
    ],
  };
}
