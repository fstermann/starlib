/**
 * String transformation utilities for audio metadata.
 * TypeScript ports of soundcloud_tools/utils/string.py
 */

function removeDoubleSpaces(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function removeFreeDl(text: string): string {
  return text.replace(/[([{]\s*free\s*(dl|download)\s*.*?[)\]}]/gi, '').trim();
}

function removePremiere(text: string): string {
  return text.replace(/(premiere|premear):?/gi, '').trim();
}

function isRemix(title: string): boolean {
  return /\(.*edit|mix|bootleg|rework|flip.*\)/i.test(title);
}

export function cleanTitle(title: string): string {
  title = removeDoubleSpaces(title);
  title = removeFreeDl(title);
  title = removePremiere(title);
  if (isRemix(title)) return title;
  const match = title.match(/.*?\s*-\s*(.*)/);
  if (match) title = match[1];
  return title;
}

export function cleanArtist(artist: string): string {
  artist = removeDoubleSpaces(artist);
  artist = removeFreeDl(artist);
  artist = removePremiere(artist);
  return artist.replace(/\s+(&|and|x|X)\s+/g, ', ');
}

export function titelize(text: string): string {
  text = text
    .split(' ')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
  text = text.replace(/\bdj\b/gi, 'DJ');
  text = text.replace(/'S\b/g, "'s");
  text = text.replace(/'Re\b/g, "'re");
  text = text.replace(/'T\b/g, "'t");
  return text;
}

export function removeOriginalMix(title: string): string {
  return title.replace(/\(.*original mix.*\)/gi, '').trim();
}

export function removeParenthesis(title: string): string {
  return title.replace(/\[.*?\]/g, '').trim();
}

export function parseFilename(filename: string): { artist?: string; title?: string } {
  const stem = filename
    .replace(/\.(mp3|aiff|wav|flac|m4a|ogg)$/i, '')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const match = stem.match(/^(.+?)\s+-\s+(.+)$/);
  if (match) {
    return { artist: match[1].trim(), title: match[2].trim() };
  }

  return { title: stem };
}

// Ordered from most-specific to least-specific so multi-word suffixes match before sub-words
const MIX_SUFFIX_MAP: Array<[RegExp, string]> = [
  [/\bvip\s+(?:mix|remix)$/i, 'VIP Mix'],
  [/\bextended\s+mix$/i, 'Extended Mix'],
  [/\bradio\s+edit$/i, 'Radio Edit'],
  [/\bclub\s+mix$/i, 'Club Mix'],
  [/\bdub\s+mix$/i, 'Dub Mix'],
  [/\bremix$/i, 'Remix'],
  [/\bedit$/i, 'Remix'],
  [/\bmix$/i, 'Remix'],
  [/\bbootleg$/i, 'Remix'],
  [/\brework$/i, 'Remix'],
  [/\bflip$/i, 'Remix'],
];

/**
 * Detect remix info from a track title like "Track (Remixer Remix)".
 * Returns null for non-remixes or "Original Mix".
 */
export function parseRemix(title: string): { remixer: string; mixName: string } | null {
  const parenMatch = title.match(/\(([^)]+)\)/);
  if (!parenMatch) return null;

  const inner = parenMatch[1].trim();

  // Not a remix
  if (/^original(\s+mix)?$/i.test(inner)) return null;

  for (const [pattern, mixName] of MIX_SUFFIX_MAP) {
    if (!pattern.test(inner)) continue;
    const remixer = inner.replace(pattern, '').trim();
    if (!remixer) continue;
    return { remixer, mixName };
  }

  return null;
}
