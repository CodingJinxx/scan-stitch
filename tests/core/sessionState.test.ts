import { describe, expect, it } from 'vitest';
import { SessionState } from '../../src/core/sessionState';
import type { SessionData } from '../../src/types';

function base(): SessionData {
  return {
    id: 's1',
    startedAt: 1,
    watchRoot: 'C:\\Scans',
    destinationFolder: 'Inbox',
    templateName: 't',
    filename: 'f',
    appendTarget: null,
    pages: [],
    discardedPaths: [],
    phase: 'scanning',
  };
}

const A = 'C:\\Scans\\2026_06_29\\IMG_0001.pdf';
const B = 'C:\\Scans\\2026_10_13\\IMG_0001.pdf';

function three(): SessionState {
  const s = new SessionState(base());
  s.addFile('a.pdf', 1, 'pdf', 1);
  s.addFile('b.pdf', 1, 'pdf', 2);
  s.addFile('c.pdf', 1, 'pdf', 3);
  return s;
}
const ids = (s: SessionState): string[] => s.data.pages.map((p) => p.id);

describe('SessionState add/discard', () => {
  it('keeps same-named files from different folders distinct, in arrival order', () => {
    const s = new SessionState(base());
    s.addFile(A, 1, 'pdf', 10);
    s.addFile(B, 1, 'pdf', 20);
    expect(ids(s)).toEqual([`${A}#0`, `${B}#0`]);
    expect(s.countFiles()).toBe(2);
  });

  it('ignores the same path added twice', () => {
    const s = new SessionState(base());
    expect(s.addFile(A, 1, 'pdf', 1)).toHaveLength(1);
    expect(s.addFile(A, 1, 'pdf', 2)).toEqual([]);
    expect(s.data.pages).toHaveLength(1);
  });

  it('gives a 3-page file ids path#0..2 and counts it as one file', () => {
    const s = new SessionState(base());
    const added = s.addFile('x.pdf', 3, 'pdf', 5);
    expect(added.map((p) => p.id)).toEqual(['x.pdf#0', 'x.pdf#1', 'x.pdf#2']);
    expect(added.every((p) => p.rotation === 0 && p.seenAt === 5)).toBe(true);
    expect(s.countFiles()).toBe(1);
  });

  it('discards the last file, blocks re-adding it, accepts new paths', () => {
    const s = new SessionState(base());
    s.addFile('x.pdf', 3, 'pdf', 1);
    expect(s.discardLastFile()).toBe('x.pdf');
    expect(s.data.pages).toHaveLength(0);
    expect(s.data.discardedPaths).toEqual(['x.pdf']);
    expect(s.addFile('x.pdf', 3, 'pdf', 2)).toEqual([]);
    expect(s.addFile('y.pdf', 1, 'pdf', 3)).toHaveLength(1);
  });

  it('discards repeatedly down to zero then returns null', () => {
    const s = three();
    expect(s.discardLastFile()).toBe('c.pdf');
    expect(s.discardLastFile()).toBe('b.pdf');
    expect(s.discardLastFile()).toBe('a.pdf');
    expect(s.discardLastFile()).toBeNull();
    expect(s.data.pages).toHaveLength(0);
  });
});

describe('SessionState review mutations', () => {
  it('rotates by 90, wrapping both ways', () => {
    const s = new SessionState(base());
    s.addFile('x', 1, 'image', 1);
    for (let i = 0; i < 4; i++) s.rotate(['x#0'], 1);
    expect(s.data.pages[0].rotation).toBe(0);
    s.rotate(['x#0'], -1);
    expect(s.data.pages[0].rotation).toBe(270);
  });

  it('rotates a range of ids', () => {
    const s = three();
    s.rotate(['a.pdf#0', 'b.pdf#0'], 1);
    expect(s.data.pages.map((p) => p.rotation)).toEqual([90, 90, 0]);
  });

  it('remove then undo restores position; redo removes again', () => {
    const s = three();
    s.remove(['b.pdf#0']);
    expect(ids(s)).toEqual(['a.pdf#0', 'c.pdf#0']);
    expect(s.undo()).toBe(true);
    expect(ids(s)).toEqual(['a.pdf#0', 'b.pdf#0', 'c.pdf#0']);
    expect(s.redo()).toBe(true);
    expect(ids(s)).toEqual(['a.pdf#0', 'c.pdf#0']);
  });

  it('move then undo/redo', () => {
    const s = three();
    s.move('a.pdf#0', 2);
    expect(ids(s)).toEqual(['b.pdf#0', 'c.pdf#0', 'a.pdf#0']);
    s.undo();
    expect(ids(s)).toEqual(['a.pdf#0', 'b.pdf#0', 'c.pdf#0']);
    s.redo();
    expect(ids(s)).toEqual(['b.pdf#0', 'c.pdf#0', 'a.pdf#0']);
  });

  it('a new mutation after undo clears redo', () => {
    const s = three();
    s.remove(['a.pdf#0']);
    s.undo();
    s.rotate(['b.pdf#0'], 1);
    expect(s.redo()).toBe(false);
  });

  it('undo/redo return false when empty', () => {
    const s = three();
    expect(s.undo()).toBe(false);
    expect(s.redo()).toBe(false);
  });

  it('can remove all pages', () => {
    const s = three();
    s.remove(ids(s));
    expect(s.data.pages.length).toBe(0);
  });

  it('caps undo history at 200', () => {
    const s = three();
    for (let i = 0; i < 250; i++) s.rotate(['a.pdf#0'], 1);
    let n = 0;
    while (s.undo()) n++;
    expect(n).toBe(200);
  });
});

describe('SessionState serialisation', () => {
  it('round-trips through JSON', () => {
    const s = three();
    s.rotate(['a.pdf#0'], 1);
    s.discardLastFile();
    const copy = new SessionState(JSON.parse(JSON.stringify(s.toJSON())) as SessionData);
    expect(copy.toJSON()).toEqual(s.toJSON());
  });

  it('does not alias input or output arrays', () => {
    const input = base();
    const s = new SessionState(input);
    s.addFile('x', 1, 'pdf', 1);
    expect(input.pages).toHaveLength(0);
    const out = s.toJSON();
    out.pages.pop();
    expect(s.data.pages).toHaveLength(1);
  });
});

describe('SessionState history barriers', () => {
  it('addFile after remove clears undo and keeps the new pages', () => {
    const s = three();
    s.remove(['a.pdf#0']);
    s.addFile('n.pdf', 2, 'pdf', 9);
    expect(s.undo()).toBe(false);
    expect(ids(s)).toEqual(['b.pdf#0', 'c.pdf#0', 'n.pdf#0', 'n.pdf#1']);
  });

  it('discardLastFile after remove clears undo and keeps the file gone', () => {
    const s = three();
    s.remove(['a.pdf#0']);
    expect(s.discardLastFile()).toBe('c.pdf');
    expect(s.undo()).toBe(false);
    expect(ids(s)).toEqual(['b.pdf#0']);
  });

  it('addFile that adds nothing keeps history; discard on empty keeps history', () => {
    const s = three();
    s.remove(['a.pdf#0']);
    s.addFile('b.pdf', 1, 'pdf', 9);
    expect(s.undo()).toBe(true);
    const e = new SessionState(base());
    e.discardLastFile();
    expect(e.undo()).toBe(false);
  });

  it('no-op rotate/remove neither create undo steps nor wipe redo', () => {
    const s = three();
    s.rotate([], 1);
    s.remove(['nope']);
    s.rotate(['nope'], -1);
    expect(s.undo()).toBe(false);
    s.remove(['a.pdf#0']);
    s.undo();
    s.rotate(['nope'], 1);
    s.remove([]);
    expect(s.redo()).toBe(true);
    expect(ids(s)).toEqual(['b.pdf#0', 'c.pdf#0']);
  });
});
