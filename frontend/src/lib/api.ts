/**
 * API client for FastAPI backend.
 *
 * Types are generated from the backend OpenAPI spec — see `npm run generate:backend`.
 */

import type { components } from '@/generated/backend';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public data?: unknown
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function fetchApi<T>(
  endpoint: string,
  options?: RequestInit
): Promise<T> {
  const url = `${API_BASE_URL}${endpoint}`;

  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: 'Unknown error' }));
    throw new ApiError(
      error.detail || `HTTP ${response.status}`,
      response.status,
      error
    );
  }

  if (response.status === 204 || response.headers.get('content-length') === '0') {
    return undefined as T;
  }

  return response.json();
}

// ==================== Types (generated from backend OpenAPI spec) ====================

export type TrackInfo = components['schemas']['TrackInfoResponse'];

export type TrackBrowse = components['schemas']['TrackBrowseResponse'] & {
  remixers?: string[] | null;
  soundcloud_id?: number | null;
  mtime?: number | null;
};

export type BrowsePage = components['schemas']['Page_TrackBrowseResponse_'] & {
  cacheLoading?: boolean;
};

export interface BrowseParams {
  page?: number;
  size?: number;
  search?: string;
  genres?: string[];
  artists?: string[];
  keys?: string[];
  bpm_min?: number;
  bpm_max?: number;
  date_from?: string;
  date_to?: string;
  sort_by?: 'title' | 'artist' | 'genre' | 'bpm' | 'key' | 'release_date' | 'file_name' | 'mtime';
  sort_order?: 'asc' | 'desc';
}

export type FilterValues = components['schemas']['FilterValuesResponse'];

export type FileInfo = components['schemas']['FileInfoResponse'];

export type FilePage = components['schemas']['Page_FileInfoResponse_'];

export type TrackInfoUpdateRequest = components['schemas']['TrackInfoUpdateRequest'];

export type OperationResponse = components['schemas']['OperationResponse'];

export type FinalizeResponse = components['schemas']['FinalizeResponse'] & {
  steps?: { id: string; type: RuleType; status: 'done' | 'skipped'; message: string }[];
};

// ==================== Batch Types ====================

export interface BatchUpdateItem {
  file_path: string;
  updates: TrackInfoUpdateRequest;
}

export interface BatchResultItem {
  file_path: string;
  success: boolean;
  message: string;
  new_file_path?: string | null;
}

export interface BatchUpdateResponse {
  results: BatchResultItem[];
}

// ==================== Ruleset Types ====================

export type RuleType = 'move' | 'convert' | 'copy';

/** Output names produced by each rule type. */
export const RULE_OUTPUTS: Record<RuleType, readonly string[]> = {
  move: ['moved'],
  copy: ['original', 'copy'],
  convert: ['original', 'converted', 'result'],
} as const;

export interface Rule {
  /** Stable id within the ruleset; used as a prefix when referencing outputs. */
  id: string;
  type: RuleType;
  /** The file the rule operates on. Either "source" or "<rule_id>.<output_name>". */
  input: string;
  /** Extra refs that must exist for the rule to fire (gates the rule on a sibling's success). */
  requires: string[];
  params: Record<string, unknown>;
}

export interface Ruleset {
  id: string;
  name: string;
  is_builtin: boolean;
  rules: Rule[];
}

export interface RulesetsResponse {
  rulesets: Ruleset[];
  active_ruleset_id: string;
}

export interface RulesetCreate {
  name: string;
  rules: Rule[];
}

export interface RulesetUpdate {
  name?: string;
  rules?: Rule[];
}

// ==================== App Settings Types ====================

export interface AppSettings {
  preferred_output_format: 'aiff' | 'mp3';
}

// ==================== Folder Config Types ====================

export interface FolderConfig {
  name: string;
  label: string;
  visible: boolean;
  order: number;
  ruleset_id: string | null;
}

export interface FoldersConfig {
  folders: FolderConfig[];
}

// ==================== API Methods ====================

export const api = {
  // File operations
  async listFiles(mode: string, page = 1, size = 50, signal?: AbortSignal): Promise<FilePage> {
    return fetchApi(`/api/metadata/folders/${mode}/files?page=${page}&size=${size}`, { signal });
  },

  async getTrackInfo(filePath: string): Promise<TrackInfo> {
    const encoded = encodeURIComponent(filePath);
    return fetchApi(`/api/metadata/files/${encoded}/info`);
  },

  async updateTrackInfo(
    filePath: string,
    updates: TrackInfoUpdateRequest
  ): Promise<OperationResponse> {
    const encoded = encodeURIComponent(filePath);
    return fetchApi(`/api/metadata/files/${encoded}/info`, {
      method: 'POST',
      body: JSON.stringify(updates),
    });
  },

  async finalizeTrack(
    filePath: string,
    options: {
      target_format?: 'mp3' | 'aiff';
      quality?: number;
      collection_folder?: string;
    }
  ): Promise<FinalizeResponse> {
    const encoded = encodeURIComponent(filePath);
    return fetchApi(`/api/metadata/files/${encoded}/finalize`, {
      method: 'POST',
      body: JSON.stringify(options),
    });
  },

  async deleteFile(
    filePath: string
  ): Promise<OperationResponse> {
    const encoded = encodeURIComponent(filePath);
    return fetchApi(`/api/metadata/files/${encoded}`, {
      method: 'DELETE',
    });
  },

  // Batch operations
  async batchGetTrackInfo(filePaths: string[]): Promise<TrackInfo[]> {
    return fetchApi('/api/metadata/files/batch-info', {
      method: 'POST',
      body: JSON.stringify({ file_paths: filePaths }),
    });
  },

  async batchUpdateTrackInfo(items: BatchUpdateItem[]): Promise<BatchUpdateResponse> {
    return fetchApi('/api/metadata/files/batch-update', {
      method: 'POST',
      body: JSON.stringify({ items }),
    });
  },

  // Artwork operations
  async getArtwork(filePath: string): Promise<Blob> {
    const encoded = encodeURIComponent(filePath);
    const response = await fetch(`${API_BASE_URL}/api/metadata/files/${encoded}/artwork`);
    if (!response.ok) {
      throw new ApiError('Failed to fetch artwork', response.status);
    }
    return response.blob();
  },

  async uploadArtwork(
    filePath: string,
    artworkFile: File
  ): Promise<OperationResponse> {
    const encoded = encodeURIComponent(filePath);
    const formData = new FormData();
    formData.append('file', artworkFile);

    const response = await fetch(`${API_BASE_URL}/api/metadata/files/${encoded}/artwork`, {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ detail: 'Upload failed' }));
      throw new ApiError(error.detail, response.status, error);
    }

    return response.json();
  },

  async removeArtwork(
    filePath: string
  ): Promise<OperationResponse> {
    const encoded = encodeURIComponent(filePath);
    return fetchApi(`/api/metadata/files/${encoded}/artwork`, {
      method: 'DELETE',
    });
  },

  // Artwork URL (for use directly in <img> src)
  getArtworkUrl(filePath: string): string {
    const encoded = encodeURIComponent(filePath);
    return `${API_BASE_URL}/api/metadata/files/${encoded}/artwork`;
  },

  // Audio streaming
  getAudioUrl(filePath: string): string {
    const encoded = encodeURIComponent(filePath);
    return `${API_BASE_URL}/api/metadata/files/${encoded}/audio`;
  },

  // Image proxy (for SoundCloud CDN images — avoids browser CORS)
  async proxyImage(url: string): Promise<Blob> {
    const response = await fetch(`${API_BASE_URL}/api/metadata/proxy-image?url=${encodeURIComponent(url)}`);
    if (!response.ok) throw new ApiError('Failed to proxy image', response.status);
    return response.blob();
  },

  proxyImageUrl(url: string): string {
    return `${API_BASE_URL}/api/metadata/proxy-image?url=${encodeURIComponent(url)}`;
  },

  // Health check
  async healthCheck(): Promise<{ status: string }> {
    return fetchApi('/health');
  },

  // Setup
  async getSetupStatus(): Promise<components['schemas']['SetupStatusResponse']> {
    return fetchApi('/api/setup/status');
  },

  async saveSetup(data: components['schemas']['SetupRequest']): Promise<components['schemas']['SetupResponse']> {
    return fetchApi('/api/setup', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  async initializeFolders(): Promise<OperationResponse> {
    return fetchApi('/api/metadata/folders/initialize', { method: 'POST' });
  },
  // Browse (view mode) — full metadata with filtering, sorting, pagination
  async browseFiles(mode: string, params: BrowseParams = {}, signal?: AbortSignal): Promise<BrowsePage> {
    const qs = new URLSearchParams();
    if (params.page) qs.set('page', String(params.page));
    if (params.size) qs.set('size', String(params.size));
    if (params.search) qs.set('search', params.search);
    params.genres?.forEach((g) => qs.append('genres', g));
    params.artists?.forEach((a) => qs.append('artists', a));
    params.keys?.forEach((k) => qs.append('keys', k));
    if (params.bpm_min !== undefined) qs.set('bpm_min', String(params.bpm_min));
    if (params.bpm_max !== undefined) qs.set('bpm_max', String(params.bpm_max));
    if (params.date_from) qs.set('date_from', params.date_from);
    if (params.date_to) qs.set('date_to', params.date_to);
    if (params.sort_by) qs.set('sort_by', params.sort_by);
    if (params.sort_order) qs.set('sort_order', params.sort_order);
    const url = `${API_BASE_URL}/api/metadata/folders/${mode}/browse?${qs.toString()}`;
    const response = await fetch(url, { signal });
    if (!response.ok) {
      throw new ApiError(`API error: ${response.status}`, response.status);
    }
    const data = await response.json();
    data.cacheLoading = response.headers.get('X-Cache-Loading') === 'true';
    return data as BrowsePage;
  },

  // Get available filter values for a folder (with optional active filters for faceted counts)
  async getFilterValues(
    mode: string,
    params?: {
      search?: string;
      genres?: string[];
      keys?: string[];
      bpmMin?: number;
      bpmMax?: number;
    }
  ): Promise<FilterValues> {
    const qs = new URLSearchParams();
    if (params?.search) qs.set('search', params.search);
    params?.genres?.forEach((g) => qs.append('genres', g));
    params?.keys?.forEach((k) => qs.append('keys', k));
    if (params?.bpmMin !== undefined) qs.set('bpm_min', String(params.bpmMin));
    if (params?.bpmMax !== undefined) qs.set('bpm_max', String(params.bpmMax));
    const query = qs.toString();
    return fetchApi(`/api/metadata/folders/${mode}/filter-values${query ? `?${query}` : ''}`);
  },

  // Get waveform peaks for a file (cached server-side)
  async getFilePeaks(filePath: string, numPeaks = 200, signal?: AbortSignal): Promise<number[]> {
    const encoded = encodeURIComponent(filePath);
    const data = await fetchApi<{ peaks: number[] }>(
      `/api/metadata/files/${encoded}/peaks?num_peaks=${numPeaks}`,
      { signal }
    );
    return data.peaks;
  },

  // Collection SoundCloud IDs
  async getCollectionSoundcloudIds(): Promise<number[]> {
    const data = await fetchApi<components['schemas']['CollectionSoundcloudIdsResponse']>(
      '/api/metadata/collection/soundcloud-ids'
    );
    return data.soundcloud_ids;
  },

  // ==================== Rulesets ====================

  async getRulesets(): Promise<RulesetsResponse> {
    return fetchApi('/api/rulesets');
  },

  async getActiveRuleset(): Promise<Ruleset> {
    return fetchApi('/api/rulesets/active');
  },

  async createRuleset(data: RulesetCreate): Promise<Ruleset> {
    return fetchApi('/api/rulesets', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  async updateRuleset(id: string, data: RulesetUpdate): Promise<Ruleset> {
    return fetchApi(`/api/rulesets/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  },

  async deleteRuleset(id: string): Promise<void> {
    await fetchApi(`/api/rulesets/${id}`, { method: 'DELETE' });
  },

  async activateRuleset(id: string): Promise<Ruleset> {
    return fetchApi(`/api/rulesets/${id}/activate`, { method: 'PUT' });
  },

  // ==================== Folder Config ====================

  async getFoldersConfig(): Promise<FoldersConfig> {
    return fetchApi('/api/folders/config');
  },

  async updateFoldersConfig(config: FoldersConfig): Promise<FoldersConfig> {
    return fetchApi('/api/folders/config', {
      method: 'PUT',
      body: JSON.stringify(config),
    });
  },

  // ==================== App Settings ====================

  async getAppSettings(): Promise<AppSettings> {
    return fetchApi('/api/settings');
  },

  async updateAppSettings(settings: Partial<AppSettings>): Promise<AppSettings> {
    return fetchApi('/api/settings', {
      method: 'PUT',
      body: JSON.stringify(settings),
    });
  },

  async getRootMusicFolder(): Promise<string> {
    const data = await fetchApi<{ root_music_folder: string }>('/api/settings/root-folder');
    return data.root_music_folder;
  },

  async updateRootMusicFolder(path: string): Promise<string> {
    const data = await fetchApi<{ root_music_folder: string }>('/api/settings/root-folder', {
      method: 'PUT',
      body: JSON.stringify({ root_music_folder: path }),
    });
    return data.root_music_folder;
  },
};
