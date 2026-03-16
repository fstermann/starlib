/**
 * Auth token lifecycle management.
 * Handles token storage, expiry checks, and refresh via backend.
 */

import { fetchApi } from './api';

const ACCESS_TOKEN_KEY = 'access_token';
const REFRESH_TOKEN_KEY = 'refresh_token';
const EXPIRES_AT_KEY = 'token_expires_at';

interface RefreshResponse {
  access_token: string;
  refresh_token: string | null;
  expires_in: number | null;
}

export function getAccessToken(): string | null {
  return localStorage.getItem(ACCESS_TOKEN_KEY);
}

export function getRefreshToken(): string | null {
  return localStorage.getItem(REFRESH_TOKEN_KEY);
}

export function storeTokens(accessToken: string, refreshToken: string | null, expiresIn: number | null): void {
  localStorage.setItem(ACCESS_TOKEN_KEY, accessToken);
  if (refreshToken) localStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);
  if (expiresIn) {
    const expiresAt = Date.now() + expiresIn * 1000;
    localStorage.setItem(EXPIRES_AT_KEY, String(expiresAt));
  }
}

export function clearTokens(): void {
  localStorage.removeItem(ACCESS_TOKEN_KEY);
  localStorage.removeItem(REFRESH_TOKEN_KEY);
  localStorage.removeItem(EXPIRES_AT_KEY);
  localStorage.removeItem('sc_user');
}

export function isTokenExpired(): boolean {
  const expiresAt = localStorage.getItem(EXPIRES_AT_KEY);
  if (!expiresAt) return false; // unknown — assume valid
  // Treat as expired 60s early to avoid race conditions
  return Date.now() > Number(expiresAt) - 60_000;
}

export async function refreshToken(): Promise<string> {
  const refresh = getRefreshToken();
  if (!refresh) throw new Error('No refresh token available');

  const data = await fetchApi<RefreshResponse>('/auth/soundcloud/refresh', {
    method: 'POST',
    body: JSON.stringify({ refresh_token: refresh }),
  });

  storeTokens(data.access_token, data.refresh_token, data.expires_in);
  return data.access_token;
}

/** Returns a valid access token, refreshing if necessary. */
export async function ensureValidToken(): Promise<string> {
  if (isTokenExpired()) return refreshToken();
  const token = getAccessToken();
  if (!token) throw new Error('Not authenticated');
  return token;
}
