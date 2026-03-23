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
  async listFiles(mode: string, page = 1, size = 50): Promise<FilePage> {
    return fetchApi(`/api/metadata/folders/${mode}/files?page=${page}&size=${size}`);
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

  // Beat analysis
  async analyzeBeats(filePath: string): Promise<{ bpm: number; beats: number[]; downbeats: number[] }> {
    return fetchApi('/api/beats/analyze', {
      method: 'POST',
      body: JSON.stringify({ file_path: filePath }),
    });
  },

  // Rekordbox ANLZ waveform
  async getRekordboxWaveform(filePath: string): Promise<{
    entries: { height: number; r: number; g: number; b: number }[];
    beats: { beat: number; tempo: number; time: number }[];
    found: boolean;
    source: string;
  }> {
    return fetchApi(`/api/rekordbox/waveform?file_path=${encodeURIComponent(filePath)}`);
  },

  // Health check
  async healthCheck(): Promise<{ status: string }> {
    return fetchApi('/health');
  },
};
