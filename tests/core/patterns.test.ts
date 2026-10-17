import { describe, expect, it } from 'vitest';
import { kindOf, matchesAnyPattern } from '../../src/core/patterns';

describe('matchesAnyPattern', () => {
  it('matches case-insensitively', () => {
    expect(matchesAnyPattern('IMG_0001.PDF', ['*.pdf'])).toBe(true);
  });
  it('matches by extension globs', () => {
    expect(matchesAnyPattern('a.jpg', ['*.pdf'])).toBe(false);
    expect(matchesAnyPattern('a.jpg', ['*.jpg', '*.jpeg'])).toBe(true);
  });
  it('supports ? and anchors', () => {
    expect(matchesAnyPattern('a1.pdf', ['a?.pdf'])).toBe(true);
    expect(matchesAnyPattern('a12.pdf', ['a?.pdf'])).toBe(false);
    expect(matchesAnyPattern('xa.pdf.bak', ['*.pdf'])).toBe(false);
  });
  it('never matches temp or hidden files', () => {
    expect(matchesAnyPattern('~$tmp.pdf', ['*.pdf'])).toBe(false);
    expect(matchesAnyPattern('.hidden.pdf', ['*.pdf'])).toBe(false);
    expect(matchesAnyPattern('IMG_0001.pdf.tmp', ['*.tmp'])).toBe(false);
  });
});

describe('kindOf', () => {
  it('classifies extensions', () => {
    expect(kindOf('x.png')).toBe('image');
    expect(kindOf('x.JPEG')).toBe('image');
    expect(kindOf('x.pdf')).toBe('pdf');
    expect(kindOf('x.tif')).toBeNull();
  });
});
