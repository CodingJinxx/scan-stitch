import { describe, expect, it } from 'vitest';
import { pushRecent } from '../../src/core/recents';

describe('pushRecent', () => {
  it('puts new folder first', () => {
    expect(pushRecent(['a', 'b'], 'c')).toEqual(['c', 'a', 'b']);
  });
  it('moves existing entry to front without duplicating, case-insensitively, keeping new spelling', () => {
    expect(pushRecent(['a', 'Docs', 'b'], 'docs')).toEqual(['docs', 'a', 'b']);
  });
  it('caps at 5 by default', () => {
    expect(pushRecent(['1', '2', '3', '4', '5'], '6')).toEqual(['6', '1', '2', '3', '4']);
  });
  it('respects custom max', () => {
    expect(pushRecent(['1', '2', '3'], '4', 2)).toEqual(['4', '1']);
  });
  it('ignores blank folders and returns a copy', () => {
    const list = ['a'];
    const out = pushRecent(list, '   ');
    expect(out).toEqual(['a']);
    expect(out).not.toBe(list);
    expect(pushRecent(list, '')).toEqual(['a']);
  });
  it('does not mutate input', () => {
    const list = ['a', 'b'];
    pushRecent(list, 'b');
    expect(list).toEqual(['a', 'b']);
  });
});
