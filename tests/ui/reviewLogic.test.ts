import { describe, expect, it } from 'vitest';
import {
  ReviewCursor,
  autoFilename,
  counterText,
  mapKey,
  reorderTarget,
  rotationDelta,
} from '../../src/ui/reviewLogic';

const key = (k: string, mods: Partial<{ shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {}) => ({
  key: k,
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  ...mods,
});

describe('mapKey', () => {
  it('maps rotation keys', () => {
    expect(mapKey(key('r'))).toBe('rotateCw');
    expect(mapKey(key('R', { shiftKey: true }))).toBe('rotateCcw');
    expect(mapKey(key('R'))).toBe('rotateCcw');
    expect(mapKey(key('r', { shiftKey: true }))).toBe('rotateCcw');
  });

  it('does not rotate with ctrl, meta or alt held', () => {
    expect(mapKey(key('r', { ctrlKey: true }))).toBeNull();
    expect(mapKey(key('r', { metaKey: true }))).toBeNull();
    expect(mapKey(key('R', { ctrlKey: true, shiftKey: true }))).toBeNull();
    expect(mapKey(key('r', { altKey: true }))).toBeNull();
  });

  it('maps navigation keys', () => {
    expect(mapKey(key('ArrowLeft'))).toBe('prev');
    expect(mapKey(key('ArrowRight'))).toBe('next');
    expect(mapKey(key('Home'))).toBe('first');
    expect(mapKey(key('End'))).toBe('last');
  });

  it('maps remove, save and cancel', () => {
    expect(mapKey(key('Delete'))).toBe('remove');
    expect(mapKey(key('Backspace'))).toBe('remove');
    expect(mapKey(key('Enter'))).toBe('save');
    expect(mapKey(key('Escape'))).toBe('cancel');
  });

  it('maps undo, redo and select all with ctrl or meta', () => {
    expect(mapKey(key('z', { ctrlKey: true }))).toBe('undo');
    expect(mapKey(key('z', { metaKey: true }))).toBe('undo');
    expect(mapKey(key('y', { ctrlKey: true }))).toBe('redo');
    expect(mapKey(key('y', { metaKey: true }))).toBe('redo');
    expect(mapKey(key('Z', { ctrlKey: true, shiftKey: true }))).toBe('redo');
    expect(mapKey(key('z', { metaKey: true, shiftKey: true }))).toBe('redo');
    expect(mapKey(key('a', { ctrlKey: true }))).toBe('selectAll');
    expect(mapKey(key('A', { metaKey: true }))).toBe('selectAll');
  });

  it('ignores plain letters and unknown combinations', () => {
    expect(mapKey(key('z'))).toBeNull();
    expect(mapKey(key('a'))).toBeNull();
    expect(mapKey(key('x', { ctrlKey: true }))).toBeNull();
    expect(mapKey(key('Tab'))).toBeNull();
    expect(mapKey(key('ArrowLeft', { ctrlKey: true }))).toBeNull();
  });
});

const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => `p${i}`);

describe('ReviewCursor', () => {
  it('starts on page 1 with nothing selected', () => {
    const c = new ReviewCursor();
    c.sync(ids(5));
    expect(c.index).toBe(0);
    expect(c.currentId).toBe('p0');
    expect(c.selectedIds()).toEqual([]);
    expect(c.targetIds()).toEqual(['p0']);
  });

  it('handles an empty list', () => {
    const c = new ReviewCursor();
    c.sync([]);
    expect(c.index).toBe(-1);
    expect(c.currentId).toBeNull();
    expect(c.targetIds()).toEqual([]);
    c.next();
    c.last();
    c.click(3, true);
    c.selectAll();
    expect(c.index).toBe(-1);
    expect(c.targetIds()).toEqual([]);
  });

  it('navigates and clamps at both ends', () => {
    const c = new ReviewCursor();
    c.sync(ids(3));
    c.prev();
    expect(c.index).toBe(0);
    c.next();
    c.next();
    c.next();
    expect(c.index).toBe(2);
    c.first();
    expect(c.index).toBe(0);
    c.last();
    expect(c.index).toBe(2);
  });

  it('plain click jumps and resets the selection to that page', () => {
    const c = new ReviewCursor();
    c.sync(ids(6));
    c.selectAll();
    c.click(4, false);
    expect(c.index).toBe(4);
    expect(c.selectedIds()).toEqual([]);
    expect(c.targetIds()).toEqual(['p4']);
  });

  it('shift+click selects a range from the anchor, in either direction', () => {
    const c = new ReviewCursor();
    c.sync(ids(8));
    c.click(2, false);
    c.click(5, true);
    expect(c.index).toBe(5);
    expect(c.targetIds()).toEqual(['p2', 'p3', 'p4', 'p5']);
    // a second shift+click re-ranges from the same anchor
    c.click(0, true);
    expect(c.targetIds()).toEqual(['p0', 'p1', 'p2']);
    expect(c.isSelected('p1')).toBe(true);
    expect(c.isSelected('p5')).toBe(false);
  });

  it('shift+click without a previous click ranges from the current page', () => {
    const c = new ReviewCursor();
    c.sync(ids(4));
    c.click(2, true);
    expect(c.targetIds()).toEqual(['p0', 'p1', 'p2']);
  });

  it('keyboard navigation clears the selection', () => {
    const c = new ReviewCursor();
    c.sync(ids(5));
    c.click(1, false);
    c.click(3, true);
    c.next();
    expect(c.index).toBe(4);
    expect(c.selectedIds()).toEqual([]);
  });

  it('select all selects every page in order', () => {
    const c = new ReviewCursor();
    c.sync(ids(3));
    c.selectAll();
    expect(c.targetIds()).toEqual(['p0', 'p1', 'p2']);
  });

  it('follows the current page when the order changes', () => {
    const c = new ReviewCursor();
    c.sync(['a', 'b', 'c', 'd']);
    c.click(1, false);
    c.sync(['c', 'a', 'b', 'd']);
    expect(c.currentId).toBe('b');
    expect(c.index).toBe(2);
  });

  it('after removing the current page lands on the page that took its place', () => {
    const c = new ReviewCursor();
    c.sync(ids(6));
    c.click(2, false);
    c.click(4, true);
    // remove p2..p4
    c.sync(['p0', 'p1', 'p5']);
    expect(c.currentId).toBe('p5');
    expect(c.selectedIds()).toEqual([]);
  });

  it('after removing the last page clamps to the new last page', () => {
    const c = new ReviewCursor();
    c.sync(ids(3));
    c.last();
    c.sync(['p0', 'p1']);
    expect(c.index).toBe(1);
    expect(c.currentId).toBe('p1');
  });

  it('after removing every page reports the empty state, and recovers on undo', () => {
    const c = new ReviewCursor();
    c.sync(ids(2));
    c.selectAll();
    c.sync([]);
    expect(c.index).toBe(-1);
    expect(c.targetIds()).toEqual([]);
    c.sync(ids(2));
    expect(c.index).toBe(0);
  });

  it('keeps surviving selected pages after a sync', () => {
    const c = new ReviewCursor();
    c.sync(ids(4));
    c.click(0, false);
    c.click(2, true);
    c.sync(['p2', 'p0', 'p3']);
    expect(c.targetIds()).toEqual(['p2', 'p0']);
  });
});

describe('reorderTarget', () => {
  it('moves forward: dropping after a later page', () => {
    // [a b c d e], drag a after c -> [b c a d e]
    expect(reorderTarget(0, 2, true)).toBe(2);
  });

  it('moves forward: dropping before a later page', () => {
    // drag a before c -> [b a c d e]
    expect(reorderTarget(0, 2, false)).toBe(1);
  });

  it('moves backward: dropping before an earlier page', () => {
    // drag d before b -> [a d b c e]
    expect(reorderTarget(3, 1, false)).toBe(1);
  });

  it('moves backward: dropping after an earlier page', () => {
    // drag d after b -> [a b d c e]
    expect(reorderTarget(3, 1, true)).toBe(2);
  });

  it('dropping onto itself or its own edges is a no-op', () => {
    expect(reorderTarget(2, 2, false)).toBe(2);
    expect(reorderTarget(2, 2, true)).toBe(2);
    expect(reorderTarget(2, 1, true)).toBe(2);
    expect(reorderTarget(2, 3, false)).toBe(2);
  });

  it('dropping after the last page moves to the end', () => {
    expect(reorderTarget(0, 4, true)).toBe(4);
  });
});

describe('rotationDelta', () => {
  it('takes the short way round', () => {
    expect(rotationDelta(0, 90)).toBe(90);
    expect(rotationDelta(90, 0)).toBe(-90);
    expect(rotationDelta(270, 0)).toBe(90);
    expect(rotationDelta(0, 270)).toBe(-90);
    expect(rotationDelta(0, 180)).toBe(180);
    expect(rotationDelta(90, 90)).toBe(0);
  });
});

describe('counterText', () => {
  it('shows the position, the selection size and the empty state', () => {
    expect(counterText(2, 12, 0)).toBe('Page 3 / 12');
    expect(counterText(2, 12, 1)).toBe('Page 3 / 12');
    expect(counterText(2, 12, 4)).toBe('Page 3 / 12 (4 selected)');
    expect(counterText(-1, 0, 0)).toBe('No pages');
  });
});

describe('autoFilename', () => {
  const format = (d: Date, fmt: string): string =>
    fmt
      .replace('YYYY', String(d.getUTCFullYear()))
      .replace('MM', String(d.getUTCMonth() + 1).padStart(2, '0'))
      .replace('DD', String(d.getUTCDate()).padStart(2, '0'))
      .replace('HH', String(d.getUTCHours()).padStart(2, '0'))
      .replace('mm', String(d.getUTCMinutes()).padStart(2, '0'));
  const now = new Date(Date.UTC(2026, 9, 17, 9, 5));

  it('resolves {pages} with the real page count', () => {
    expect(autoFilename('Scan {date} {pages}p', { now, pages: 7, folder: 'Inbox', existingNames: [], format })).toBe(
      'Scan 2026-10-17 7p',
    );
  });

  it('sanitises the result', () => {
    expect(autoFilename('a:b/c {folder}', { now, pages: 1, folder: 'In?box', existingNames: [], format })).toBe('abc Inbox');
  });

  it('picks the next free counter in the destination', () => {
    expect(
      autoFilename('Letter {counter}', {
        now,
        pages: 2,
        folder: 'x',
        existingNames: ['Letter 1.pdf', 'Letter 2.pdf', 'Other.pdf'],
        format,
      }),
    ).toBe('Letter 3');
  });
});
