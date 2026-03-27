/**
 * API client for FastAPI backend.
 */

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

  return response.json();
}

// ==================== Types ====================

export interface TrackInfo {
  file_path: string;
  file_name: string;
  title?: string;
  artist?: string;
  bpm?: number;
  key?: string;
  genre?: string;
  comment?: string;
  release_date?: string;
  remixers?: string[];
  has_artwork: boolean;
  is_ready: boolean;
  missing_fields: string[];
  issues: string[];
}

export interface TrackBrowse {
  file_path: string;
  file_name: string;
  title?: string;
  artist?: string;
  bpm?: number;
  key?: string;
  genre?: string;
  release_date?: string;
  has_artwork: boolean;
  file_format: string;
  file_size: number;
  duration?: number;
}

export interface BrowsePage {
  items: TrackBrowse[];
  total: number;
  page: number;
  size: number;
  pages: number;
  cacheLoading?: boolean;
}

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
  sort_by?: 'title' | 'artist' | 'genre' | 'bpm' | 'key' | 'release_date' | 'file_name';
  sort_order?: 'asc' | 'desc';
}

export interface FilterValues {
  genres: string[];
  genre_counts?: Record<string, number>;
  artists: string[];
  keys: string[];
  key_counts?: Record<string, number>;
  bpm_min?: number;
  bpm_max?: number;
}

export interface FileInfo {
  file_path: string;
  file_name: string;
  file_size: number;
  file_format: string;
  has_artwork: boolean;
}

export interface FilePage {
  items: FileInfo[];
  total: number;
  page: number;
  size: number;
  pages: number;
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
    updates: Partial<TrackInfo> & { artwork_data?: string }
  ): Promise<{ success: boolean; message: string; new_file_path: string | null }> {
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
  ): Promise<{ success: boolean; message: string; new_file_path: string }> {
    const encoded = encodeURIComponent(filePath);
    return fetchApi(`/api/metadata/files/${encoded}/finalize`, {
      method: 'POST',
      body: JSON.stringify(options),
    });
  },

  async deleteFile(
    filePath: string
  ): Promise<{ success: boolean; message: string }> {
    const encoded = encodeURIComponent(filePath);
    return fetchApi(`/api/metadata/files/${encoded}`, {
      method: 'DELETE',
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
  ): Promise<{ success: boolean; message: string }> {
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
  ): Promise<{ success: boolean; message: string }> {
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

  // Health check
  async healthCheck(): Promise<{ status: string }> {
    return fetchApi('/health');
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
};
