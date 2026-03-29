/**
 * SoundCloud API client for the frontend.
 * Calls the SoundCloud API directly using the user's access token.
 * Token management is handled by src/lib/auth.ts.
 */

import createClient from 'openapi-fetch';
import type { components, paths } from '@/generated/soundcloud';
import { ensureValidToken } from './auth';

export type SCTrack = components['schemas']['Track'];
export type SCPlaylist = components['schemas']['Playlist'];
export type SCUser = components['schemas']['User'];

function createSCClient(token: string) {
  const client = createClient<paths>({ baseUrl: 'https://api.soundcloud.com' });
  client.use({
    onRequest({ request }) {
      request.headers.set('Authorization', `OAuth ${token}`);
      return request;
    },
  });
  return client;
}

async function getClient() {
  const token = await ensureValidToken();
  return createSCClient(token);
}

export async function searchTracks(query: string, limit = 20): Promise<SCTrack[]> {
  const client = await getClient();
  const { data, error } = await client.GET('/tracks', {
    params: { query: { q: query, limit } },
  });
  if (error) throw new Error(`SoundCloud search failed: ${JSON.stringify(error)}`);
  return (data as SCTrack[]) ?? [];
}

export async function resolveUrl(url: string): Promise<SCTrack | SCPlaylist | SCUser | null> {
  const client = await getClient();
  const { data, error } = await client.GET('/resolve', {
    params: { query: { url } },
  });
  if (error) throw new Error(`SoundCloud resolve failed: ${JSON.stringify(error)}`);
  return data as SCTrack | SCPlaylist | SCUser | null;
}

export async function getTrack(trackUrn: string): Promise<SCTrack | null> {
  const client = await getClient();
  const { data, error } = await client.GET('/tracks/{track_urn}', {
    params: { path: { track_urn: trackUrn } },
  });
  if (error) throw new Error(`Failed to fetch track: ${JSON.stringify(error)}`);
  return (data as SCTrack) ?? null;
}

export async function getMe(): Promise<SCUser> {
  const client = await getClient();
  const { data, error } = await client.GET('/me', {});
  if (error) throw new Error(`Failed to fetch user: ${JSON.stringify(error)}`);
  return data as SCUser;
}

export async function createPlaylist(
  title: string,
  trackIds: number[],
  options?: { description?: string; sharing?: 'public' | 'private' },
): Promise<SCPlaylist> {
  const client = await getClient();
  const { data, error } = await client.POST('/playlists', {
    body: {
      playlist: {
        title,
        sharing: options?.sharing ?? 'private',
        description: options?.description,
        tracks: trackIds.map((id) => ({ id })),
      },
    } as never,
  });
  if (error) throw new Error(`Failed to create playlist: ${JSON.stringify(error)}`);
  return data as SCPlaylist;
}

export async function addTracksToPlaylist(playlistUrn: string, trackIds: number[]): Promise<SCPlaylist> {
  const client = await getClient();
  const { data, error } = await client.PUT('/playlists/{playlist_urn}', {
    params: { path: { playlist_urn: playlistUrn } },
    body: { playlist: { tracks: trackIds.map((id) => ({ id })) } } as never,
  });
  if (error) throw new Error(`Failed to update playlist: ${JSON.stringify(error)}`);
  return data as SCPlaylist;
}

export type SCTracks = components['schemas']['Tracks'];

export async function getMyLikedTracks(
  limit = 200,
  cursor?: string,
): Promise<SCTracks> {
  const client = await getClient();
  const { data, error } = await client.GET('/me/likes/tracks', {
    params: { query: { limit, linked_partitioning: true, ...(cursor ? { offset: cursor } : {}) } as never },
  });
  if (error) throw new Error(`Failed to fetch liked tracks: ${JSON.stringify(error)}`);
  return data as SCTracks;
}

export async function getUserLikedTracks(
  userUrn: string,
  limit = 200,
  cursor?: string,
): Promise<SCTracks> {
  const client = await getClient();
  const { data, error } = await client.GET('/users/{user_urn}/likes/tracks', {
    params: {
      path: { user_urn: userUrn },
      query: { limit, linked_partitioning: true, ...(cursor ? { offset: cursor } : {}) } as never,
    },
  });
  if (error) throw new Error(`Failed to fetch user liked tracks: ${JSON.stringify(error)}`);
  return data as SCTracks;
}

export async function fetchLikesPage(nextHref: string): Promise<SCTracks> {
  const token = await ensureValidToken();
  const resp = await fetch(nextHref, {
    headers: { Authorization: `OAuth ${token}` },
  });
  if (!resp.ok) throw new Error(`Failed to fetch likes page: ${resp.status}`);
  return (await resp.json()) as SCTracks;
}

export async function getUser(userUrn: string): Promise<SCUser | null> {
  const client = await getClient();
  const { data, error } = await client.GET('/users/{user_urn}', {
    params: { path: { user_urn: userUrn } },
  });
  if (error) throw new Error(`Failed to fetch user: ${JSON.stringify(error)}`);
  return (data as SCUser) ?? null;
}

export async function searchUsers(query: string, limit = 10): Promise<SCUser[]> {
  const token = await ensureValidToken();
  const url = new URL('https://api.soundcloud.com/users');
  url.searchParams.set('q', query);
  url.searchParams.set('limit', String(limit));
  const resp = await fetch(url.toString(), {
    headers: { Authorization: `OAuth ${token}` },
  });
  if (!resp.ok) throw new Error(`User search failed: ${resp.status}`);
  const data = await resp.json();
  return (data?.collection ?? data) as SCUser[];
}
