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
}

export interface FolderList {
  folder_path: string;
  folder_mode: string;
  total_files: number;
  total_size_mb: number;
  files: FileInfo[];
}

export interface SoundCloudTrack {
  id: number;
  title: string;
  artist: string;
  permalink_url: string;
  artwork_url?: string;
  duration_ms?: number;
  genre?: string;
  release_date?: string;
  label?: string;
  isrc?: string;
  bpm?: number;
  artist_options?: string[];
}

export interface SearchResults {
  query: string;
  total_results: number;
  tracks: SoundCloudTrack[];
}

// ==================== API Methods ====================

export const api = {
  // File operations
  async listFiles(mode: string): Promise<FolderList> {
    return fetchApi(`/api/metadata/folders/${mode}/files`);
  },

  async getTrackInfo(filePath: string): Promise<TrackInfo> {
    const encoded = encodeURIComponent(filePath);
    return fetchApi(`/api/metadata/files/${encoded}/info`);
  },

  async updateTrackInfo(
    filePath: string,
    updates: Partial<TrackInfo>
  ): Promise<{ success: boolean; message: string }> {
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

  // SoundCloud operations
  async searchSoundCloud(
    query: string,
    limit = 20
  ): Promise<SearchResults> {
    return fetchApi('/api/metadata/soundcloud/search', {
      method: 'POST',
      body: JSON.stringify({ query, limit }),
    });
  },

  async getSoundCloudTrack(url: string): Promise<SoundCloudTrack> {
    return fetchApi(`/api/metadata/soundcloud/track?url=${encodeURIComponent(url)}`);
  },

  async applySoundCloudMetadata(
    filePath: string,
    soundcloudId: number
  ): Promise<{ success: boolean; message: string }> {
    return fetchApi('/api/metadata/soundcloud/apply', {
      method: 'POST',
      body: JSON.stringify({
        file_path: filePath,
        soundcloud_id: soundcloudId,
      }),
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

  // Health check
  async healthCheck(): Promise<{ status: string }> {
    return fetchApi('/health');
  },

  // Auto-actions
  async cleanTitle(text: string): Promise<{ original: string; transformed: string; changed: boolean }> {
    return fetchApi('/api/metadata/auto-actions/clean-title', {
      method: 'POST',
      body: JSON.stringify({ text }),
    });
  },

  async cleanArtist(text: string): Promise<{ original: string; transformed: string; changed: boolean }> {
    return fetchApi('/api/metadata/auto-actions/clean-artist', {
      method: 'POST',
      body: JSON.stringify({ text }),
    });
  },

  async titelize(text: string): Promise<{ original: string; transformed: string; changed: boolean }> {
    return fetchApi('/api/metadata/auto-actions/titelize', {
      method: 'POST',
      body: JSON.stringify({ text }),
    });
  },

  async removeOriginalMix(text: string): Promise<{ original: string; transformed: string; changed: boolean }> {
    return fetchApi('/api/metadata/auto-actions/remove-original-mix', {
      method: 'POST',
      body: JSON.stringify({ text }),
    });
  },

  async removeParenthesis(text: string): Promise<{ original: string; transformed: string; changed: boolean }> {
    return fetchApi('/api/metadata/auto-actions/remove-parenthesis', {
      method: 'POST',
      body: JSON.stringify({ text }),
    });
  },
};
