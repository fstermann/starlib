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
