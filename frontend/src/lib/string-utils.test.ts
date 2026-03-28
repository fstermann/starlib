import { describe, expect, it } from 'vitest';
import {
  cleanTitle,
  cleanArtist,
  titelize,
  removeMix,
  removeOriginalMix,
  removeParenthesis,
  parseFilename,
  parseRemix,
} from '@/lib/string-utils';

describe('cleanTitle', () => {
  it('removes free download tags', () => {
    expect(cleanTitle('Track Name (Free DL)')).toBe('Track Name');
    expect(cleanTitle('Track Name [free download]')).toBe('Track Name');
  });

  it('removes premiere prefix', () => {
    expect(cleanTitle('PREMIERE: Track Name')).toBe('Track Name');
  });

  it('strips artist prefix for non-remix', () => {
    expect(cleanTitle('Artist - Track Name')).toBe('Track Name');
  });

  it('preserves remix in parentheses', () => {
    const result = cleanTitle('Artist - Track (DJ Remix)');
    expect(result).toContain('Remix');
  });
});

describe('cleanArtist', () => {
  it('normalizes separators to comma', () => {
    expect(cleanArtist('A & B')).toBe('A, B');
    expect(cleanArtist('A and B')).toBe('A, B');
    expect(cleanArtist('A x B')).toBe('A, B');
  });

  it('removes free download tags', () => {
    expect(cleanArtist('Artist (Free DL)')).toBe('Artist');
  });
});

describe('titelize', () => {
  it('capitalizes each word', () => {
    expect(titelize('hello world')).toBe('Hello World');
  });

  it('uppercases DJ', () => {
    expect(titelize('dj snake')).toBe('DJ Snake');
  });

  it('keeps contractions lowercase', () => {
    expect(titelize("it's a test")).toBe("It's A Test");
  });
});

describe('removeMix', () => {
  it('removes remix parenthetical', () => {
    expect(removeMix('Track (DJ Edit)')).toBe('Track');
  });

  it('preserves non-remix parenthetical', () => {
    expect(removeMix('Track (feat. Someone)')).toBe('Track (feat. Someone)');
  });
});

describe('removeOriginalMix', () => {
  it('removes original mix', () => {
    expect(removeOriginalMix('Track (Original Mix)')).toBe('Track');
  });
});

describe('removeParenthesis', () => {
  it('removes square brackets', () => {
    expect(removeParenthesis('Track [OUT NOW]')).toBe('Track');
  });
});

describe('parseFilename', () => {
  it('parses artist - title format', () => {
    expect(parseFilename('Artist - Title.mp3')).toEqual({
      artist: 'Artist',
      title: 'Title',
    });
  });

  it('returns title only when no separator', () => {
    expect(parseFilename('Just_A_Title.wav')).toEqual({
      title: 'Just A Title',
    });
  });

  it('handles various extensions', () => {
    expect(parseFilename('A - B.flac')).toEqual({ artist: 'A', title: 'B' });
    expect(parseFilename('A - B.aiff')).toEqual({ artist: 'A', title: 'B' });
  });
});

describe('parseRemix', () => {
  it('detects remix', () => {
    expect(parseRemix('Track (DJ Remix)')).toEqual({
      remixer: 'DJ',
      mixName: 'Remix',
    });
  });

  it('detects extended mix', () => {
    expect(parseRemix('Track (Artist Extended Mix)')).toEqual({
      remixer: 'Artist',
      mixName: 'Extended Mix',
    });
  });

  it('returns null for original mix', () => {
    expect(parseRemix('Track (Original Mix)')).toBeNull();
  });

  it('returns null for no parentheses', () => {
    expect(parseRemix('Track')).toBeNull();
  });
});
