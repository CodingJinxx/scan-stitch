import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { mergePages, type MergeResult, type MergeSource } from '../../src/pdf/merge';
import type { ReplaceIO } from '../../src/pdf/safeReplace';
import { SaveError, savePages, type SaveDeps } from '../../src/ui/saveFlow';
import type { PageKind, PageRef, Rotation } from '../../src/types';
import { makeEncryptedLookingPdf, makeJpeg, makePdf } from '../fixtures/builders';

const A = 'C:\\Scans\\2026_10_17\\IMG_0001.pdf';
const B = 'C:\\Scans\\2026_10_17\\IMG_0002.pdf';
const J = 'C:\\Scans\\2026_10_17\\IMG_0003.jpg';

function page(path: string, pageIndex = 0, kind: PageKind = 'pdf', rotation: Rotation = 0): PageRef {
  return { id: `${path}#${pageIndex}`, path, pageIndex, kind, rotation, seenAt: 1 };
}

function fakeVault(existing: string[] = []) {
  const files = new Map<string, Uint8Array>();
  for (const p of existing) files.set(p, new Uint8Array([1]));
  const folders: string[] = [];
  const created: string[] = [];
  return {
    files,
    folders,
    created,
    vault: {
      exists: (p: string) => files.has(p),
      ensureFolder: (p: string) => {
        folders.push(p);
        return Promise.resolve();
      },
      createBinary: (p: string, bytes: Uint8Array) => {
        if (files.has(p)) return Promise.reject(new Error('File already exists'));
        files.set(p, bytes);
        created.push(p);
        return Promise.resolve();
      },
    },
  };
}

function fakeAppend(original: Uint8Array, opts: { failWrite?: boolean } = {}) {
  const state = { file: original, backup: null as Uint8Array | null, writes: 0, reads: 0 };
  const io: ReplaceIO = {
    read: () => {
      state.reads++;
      return Promise.resolve(state.file);
    },
    write: (b) => {
      state.writes++;
      if (opts.failWrite) return Promise.reject(new Error('EBUSY: resource busy'));
      state.file = b;
      return Promise.resolve();
    },
    saveBackup: (b) => {
      state.backup = b;
      return Promise.resolve();
    },
    removeBackup: () => {
      state.backup = null;
      return Promise.resolve();
    },
  };
  return { io, state };
}

async function sources(): Promise<Map<string, Uint8Array>> {
  return new Map([
    [A, await makePdf(['a1', 'a2'])],
    [B, await makePdf(['b1'])],
    [J, makeJpeg(300, 200)],
  ]);
}

function reader(src: Map<string, Uint8Array>) {
  const calls: string[] = [];
  return {
    calls,
    readSource: (p: string) => {
      calls.push(p);
      const b = src.get(p);
      return b ? Promise.resolve(new Uint8Array(b)) : Promise.reject(new Error(`ENOENT: ${p}`));
    },
  };
}

async function pagesOf(bytes: Uint8Array): Promise<number> {
  return (await PDFDocument.load(bytes)).getPageCount();
}

function base(over: Partial<SaveDeps> & Pick<SaveDeps, 'readSource' | 'vault'>): SaveDeps {
  return {
    pages: [page(A, 0), page(A, 1), page(B)],
    destinationFolder: 'Inbox',
    filename: 'Scan',
    appendTarget: null,
    ...over,
  };
}

describe('savePages: new file', () => {
  it('creates the folder and writes the merged pdf', async () => {
    const v = fakeVault();
    const r = reader(await sources());
    const res = await savePages(base({ readSource: r.readSource, vault: v.vault }));
    expect(res).toEqual({ path: 'Inbox/Scan.pdf', pageCount: 3, added: 3 });
    expect(v.folders).toEqual(['Inbox']);
    expect(await pagesOf(v.files.get('Inbox/Scan.pdf')!)).toBe(3);
  });

  it('never overwrites: picks the next free name', async () => {
    const v = fakeVault(['Inbox/Scan.pdf', 'Inbox/Scan 2.pdf']);
    const r = reader(await sources());
    const res = await savePages(base({ readSource: r.readSource, vault: v.vault }));
    expect(res.path).toBe('Inbox/Scan 3.pdf');
    expect(v.created).toEqual(['Inbox/Scan 3.pdf']);
    expect(v.files.get('Inbox/Scan.pdf')).toEqual(new Uint8Array([1]));
  });

  it('writes into the vault root without a leading slash', async () => {
    for (const root of ['', '/']) {
      const v = fakeVault();
      const r = reader(await sources());
      const res = await savePages(base({ destinationFolder: root, readSource: r.readSource, vault: v.vault }));
      expect(res.path).toBe('Scan.pdf');
      expect(v.folders).toEqual([]);
    }
  });

  it('trims slashes around the destination folder', async () => {
    const v = fakeVault();
    const r = reader(await sources());
    const res = await savePages(base({ destinationFolder: '/Archive/2026/', readSource: r.readSource, vault: v.vault }));
    expect(res.path).toBe('Archive/2026/Scan.pdf');
    expect(v.folders).toEqual(['Archive/2026']);
  });

  it('sanitises the name and does not double the extension', async () => {
    const v = fakeVault();
    const r = reader(await sources());
    expect((await savePages(base({ filename: 'a/b:c?', readSource: r.readSource, vault: v.vault }))).path).toBe('Inbox/abc.pdf');
    expect((await savePages(base({ filename: 'Report.PDF', readSource: r.readSource, vault: v.vault }))).path).toBe(
      'Inbox/Report.pdf',
    );
    expect((await savePages(base({ filename: '   ', readSource: r.readSource, vault: v.vault }))).path).toBe('Inbox/Scan.pdf');
  });

  it('reads each source file once and passes the same bytes instance for its pages', async () => {
    const v = fakeVault();
    const r = reader(await sources());
    let seen: MergeSource[] = [];
    const merge = (s: MergeSource[], appendTo?: Uint8Array): Promise<MergeResult> => {
      seen = s;
      return mergePages(s, appendTo);
    };
    await savePages(
      base({
        pages: [page(A, 1, 'pdf', 90), page(B), page(A, 0), page(J, 0, 'image', 270)],
        readSource: r.readSource,
        vault: v.vault,
        merge,
      }),
    );
    expect(r.calls).toEqual([A, B, J]);
    expect(seen.map((s) => [s.pageIndex, s.kind, s.rotation])).toEqual([
      [1, 'pdf', 90],
      [0, 'pdf', 0],
      [0, 'pdf', 0],
      [0, 'image', 270],
    ]);
    expect(seen[0].bytes).toBe(seen[2].bytes);
    expect(seen[0].bytes).not.toBe(seen[1].bytes);
  });

  it('rejects zero pages without touching the vault', async () => {
    const v = fakeVault();
    const r = reader(await sources());
    await expect(savePages(base({ pages: [], readSource: r.readSource, vault: v.vault }))).rejects.toThrow(SaveError);
    await expect(savePages(base({ pages: [], readSource: r.readSource, vault: v.vault }))).rejects.toThrow(/no pages/i);
    expect(v.folders).toEqual([]);
    expect(v.created).toEqual([]);
    expect(r.calls).toEqual([]);
  });

  it('names the page whose file is corrupt', async () => {
    const v = fakeVault();
    const src = await sources();
    src.set(B, new TextEncoder().encode('not a pdf'));
    const r = reader(src);
    const err = await savePages(base({ readSource: r.readSource, vault: v.vault })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SaveError);
    expect((err as Error).message).toBe('Page 3 (IMG_0002.pdf) could not be read.');
    expect(v.created).toEqual([]);
  });

  it('names the first page whose file cannot be read from disk', async () => {
    const v = fakeVault();
    const src = await sources();
    src.delete(A);
    const r = reader(src);
    const err = await savePages(base({ pages: [page(B), page(A, 1), page(A, 0)], readSource: r.readSource, vault: v.vault })).catch(
      (e: unknown) => e,
    );
    expect((err as Error).message).toBe('Page 2 (IMG_0001.pdf) could not be read.');
    expect(v.created).toEqual([]);
  });

  it('reports a failing vault write as a save error', async () => {
    const v = fakeVault();
    v.vault.createBinary = () => Promise.reject(new Error('disk full'));
    const r = reader(await sources());
    await expect(savePages(base({ readSource: r.readSource, vault: v.vault }))).rejects.toThrow('Could not save the PDF: disk full');
  });
});

describe('savePages: append', () => {
  it('appends after the existing pages via verified replace', async () => {
    const v = fakeVault();
    const r = reader(await sources());
    const a = fakeAppend(await makePdf(['old1', 'old2']));
    const res = await savePages(
      base({ appendTarget: 'Notes/Letters.pdf', readSource: r.readSource, vault: v.vault, appendIO: a.io }),
    );
    expect(res).toEqual({ path: 'Notes/Letters.pdf', pageCount: 5, added: 3 });
    expect(a.state.writes).toBe(1);
    expect(a.state.reads).toBe(1);
    expect(a.state.backup).toBeNull();
    expect(await pagesOf(a.state.file)).toBe(5);
    expect(v.created).toEqual([]);
    expect(v.folders).toEqual([]);
  });

  it('keeps the original when the target is encrypted', async () => {
    const v = fakeVault();
    const r = reader(await sources());
    const original = await makeEncryptedLookingPdf();
    const a = fakeAppend(original);
    const err = await savePages(
      base({ appendTarget: 'Notes/Locked.pdf', readSource: r.readSource, vault: v.vault, appendIO: a.io }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SaveError);
    expect((err as Error).message).toBe('Could not append to Locked.pdf: the PDF is encrypted. The original file was not changed.');
    expect(a.state.writes).toBe(0);
    expect(a.state.file).toBe(original);
  });

  it('keeps the original when the target is corrupt', async () => {
    const r = reader(await sources());
    const a = fakeAppend(new TextEncoder().encode('garbage'));
    await expect(
      savePages(base({ appendTarget: 'Bad.pdf', readSource: r.readSource, vault: fakeVault().vault, appendIO: a.io })),
    ).rejects.toThrow('Could not append to Bad.pdf: the PDF is corrupt or unreadable. The original file was not changed.');
    expect(a.state.writes).toBe(0);
  });

  it('keeps the original and names the page when a new page fails', async () => {
    const src = await sources();
    src.set(B, new TextEncoder().encode('not a pdf'));
    const r = reader(src);
    const a = fakeAppend(await makePdf(['old']));
    await expect(
      savePages(base({ appendTarget: 'X.pdf', readSource: r.readSource, vault: fakeVault().vault, appendIO: a.io })),
    ).rejects.toThrow('Page 3 (IMG_0002.pdf) could not be read.');
    expect(a.state.writes).toBe(0);
    expect(a.state.backup).not.toBeNull();
  });

  it('keeps the original when the merged result fails verification', async () => {
    const r = reader(await sources());
    const a = fakeAppend(await makePdf(['old']));
    const merge = async (s: MergeSource[], appendTo?: Uint8Array): Promise<MergeResult> => {
      const res = await mergePages(s.slice(1), appendTo);
      return res;
    };
    await expect(
      savePages(base({ appendTarget: 'X.pdf', readSource: r.readSource, vault: fakeVault().vault, appendIO: a.io, merge })),
    ).rejects.toThrow(/Verification failed/);
    expect(a.state.writes).toBe(0);
  });

  it('refuses append mode without append IO', async () => {
    const r = reader(await sources());
    await expect(savePages(base({ appendTarget: 'X.pdf', readSource: r.readSource, vault: fakeVault().vault }))).rejects.toThrow(
      SaveError,
    );
  });

  it('names the backup location when writing the target fails', async () => {
    const r = reader(await sources());
    const original = await makePdf(['old']);
    const a = fakeAppend(original, { failWrite: true });
    await expect(
      savePages(
        base({
          appendTarget: 'Notes/X.pdf',
          readSource: r.readSource,
          vault: fakeVault().vault,
          appendIO: a.io,
          appendBackupPath: 'plugin-dir/backups/20261017-101500-X.pdf',
        }),
      ),
    ).rejects.toThrow(
      'Could not append to X.pdf: EBUSY: resource busy. A copy of the original was kept at plugin-dir/backups/20261017-101500-X.pdf.',
    );
    expect(a.state.backup).toBe(original);
  });
});
