/**
 * Parse a SoundCloud track description for a fallback download link.
 *
 * SoundCloud tracks without a direct ``download_url`` often point at an
 * external download/sale page in the description text. We surface the first
 * URL we find on a known platform so the UI can render a fallback download
 * affordance instead of an empty slot.
 */

const HOSTS = ["bandcamp.com", "beatport.com", "hypeddit.com"] as const;

const URL_RE = /https?:\/\/[^\s<>"')]+/gi;

export function parseFallbackDownloadUrl(
  description: string | null | undefined,
): string | null {
  if (!description) return null;
  for (const raw of description.match(URL_RE) ?? []) {
    // Trim trailing punctuation that commonly bleeds into URL matches.
    const candidate = raw.replace(/[.,;:!?)\]]+$/, "");
    let host: string;
    try {
      host = new URL(candidate).hostname.toLowerCase();
    } catch {
      continue;
    }
    if (HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) {
      return candidate;
    }
  }
  return null;
}
