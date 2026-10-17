import { describe, expect, it } from 'vitest';
import { replaceWithVerify, type ReplaceIO } from '../../src/pdf/safeReplace';
import { mergePages, type MergeResult } from '../../src/pdf/merge';
import { makePdf } from '../fixtures/builders';

function makeIO(original: Uint8Array, opts: { failWrite?: boolean; failRemove?: boolean } = {}) {
  const calls: string[] = [];
  const state = { file: original, backup: null as Uint8Array | null };
  const io: ReplaceIO = {
    read: () => {
      calls.push('read');
      return Promise.resolve(state.file);
    },
    saveBackup: (b) => {
      calls.push('saveBackup');
      state.backup = b;
      return Promise.resolve();
    },
    write: (b) => {
      calls.push('write');
      if (opts.failWrite) return Promise.reject(new Error('disk full'));
      state.file = b;
      return Promise.resolve();
    },
    removeBackup: () => {
      calls.push('removeBackup');
      if (opts.failRemove) return Promise.reject(new Error('locked'));
      state.backup = null;
      return Promise.resolve();
    },
  };
  return { io, calls, state };
}

describe('replaceWithVerify', () => {
  it('backs up, builds, verifies, writes, then removes the backup', async () => {
    const original = await makePdf(['a']);
    const add = await makePdf(['b']);
    const { io, calls, state } = makeIO(original);
    await replaceWithVerify(io, (existing) => mergePages([{ bytes: add, kind: 'pdf', pageIndex: 0, rotation: 0 }], existing), 2);
    expect(calls).toEqual(['read', 'saveBackup', 'write', 'removeBackup']);
    expect(state.backup).toBeNull();
    expect(state.file).not.toBe(original);
  });

  it('never writes and keeps the backup when build throws', async () => {
    const original = await makePdf(['a']);
    const { io, calls, state } = makeIO(original);
    const boom = new Error('build failed');
    await expect(replaceWithVerify(io, () => Promise.reject(boom), 2)).rejects.toBe(boom);
    expect(calls).toEqual(['read', 'saveBackup']);
    expect(state.backup).toBe(original);
    expect(state.file).toBe(original);
  });

  it('never writes when the page count mismatches', async () => {
    const original = await makePdf(['a']);
    const { io, calls, state } = makeIO(original);
    await expect(replaceWithVerify(io, (e) => mergePages([], e), 5)).rejects.toThrow();
    expect(calls).not.toContain('write');
    expect(calls).not.toContain('removeBackup');
    expect(state.file).toBe(original);
    expect(state.backup).toBe(original);
  });

  it('rejects a result whose claimed pageCount differs from the real one', async () => {
    const original = await makePdf(['a']);
    const { io, calls } = makeIO(original);
    const lying = async (e: Uint8Array): Promise<MergeResult> => ({ bytes: e, pageCount: 2 });
    await expect(replaceWithVerify(io, lying, 2)).rejects.toThrow();
    expect(calls).not.toContain('write');
  });

  it('rejects unreadable result bytes', async () => {
    const original = await makePdf(['a']);
    const { io, calls } = makeIO(original);
    await expect(
      replaceWithVerify(io, () => Promise.resolve({ bytes: new Uint8Array([1, 2, 3]), pageCount: 1 }), 1),
    ).rejects.toThrow();
    expect(calls).not.toContain('write');
  });

  it('keeps the backup and rethrows when write fails', async () => {
    const original = await makePdf(['a']);
    const { io, calls, state } = makeIO(original, { failWrite: true });
    await expect(replaceWithVerify(io, (e) => mergePages([], e), 1)).rejects.toThrow('disk full');
    expect(calls).not.toContain('removeBackup');
    expect(state.backup).toBe(original);
  });

  it('does not throw when removeBackup fails after success', async () => {
    const original = await makePdf(['a']);
    const { io, calls } = makeIO(original, { failRemove: true });
    await expect(replaceWithVerify(io, (e) => mergePages([], e), 1)).resolves.toBeUndefined();
    expect(calls).toEqual(['read', 'saveBackup', 'write', 'removeBackup']);
  });
});
