import { describe, expect, it, vi } from 'vitest';
import { PageRenderer } from '../../src/pdf/pageRenderer';
import type { PageRef } from '../../src/types';

const pg = (id: string, path = 'a.pdf', pageIndex = 0, kind: PageRef['kind'] = 'pdf'): PageRef => ({
  id,
  path,
  pageIndex,
  kind,
  rotation: 0,
  seenAt: 0,
});

function setup(opts: { failPaths?: Set<string>; vw?: number; vh?: number } = {}) {
  const vw = opts.vw ?? 200;
  const vh = opts.vh ?? 400;
  const renders: Array<{ pageNumber: number; scale: number; args: Record<string, unknown> }> = [];
  const docs: Array<{ path: string; destroy: ReturnType<typeof vi.fn>; getPage: ReturnType<typeof vi.fn> }> = [];
  const loadBytes = vi.fn(async (path: string) => {
    if (opts.failPaths?.has(path)) throw new Error('boom');
    return new Uint8Array([1, 2, 3]);
  });
  const getDocument = vi.fn(({ data }: { data: Uint8Array }) => {
    void data;
    const path = loadBytes.mock.calls[loadBytes.mock.calls.length - 1][0];
    const doc = {
      path,
      destroy: vi.fn(),
      getPage: vi.fn(async (n: number) => ({
        getViewport: (args: { scale: number; rotation?: number }) => ({
          width: vw * args.scale,
          height: vh * args.scale,
          scale: args.scale,
          ...(args.rotation !== undefined ? { rotation: args.rotation } : {}),
        }),
        render: (args: Record<string, unknown>) => {
          renders.push({ pageNumber: n, scale: (args.viewport as { scale: number }).scale, args });
          return { promise: Promise.resolve() };
        },
      })),
    };
    docs.push(doc);
    return { promise: Promise.resolve(doc) };
  });
  const loadPdfJs = vi.fn(async () => ({ getDocument }));
  let n = 0;
  const created: string[] = [];
  const revoked: string[] = [];
  const canvases: Array<{ w: number; h: number }> = [];
  const env = {
    createCanvas: (w: number, h: number) => {
      canvases.push({ w, h });
      return { canvas: {}, ctx: {}, toBlob: async () => new Blob(['x'], { type: 'image/png' }) };
    },
    createObjectURL: (_b: Blob) => {
      const u = `blob:${++n}`;
      created.push(u);
      return u;
    },
    revokeObjectURL: (u: string) => {
      revoked.push(u);
    },
  };
  const decodeImage = vi.fn(async (_b: Blob) => ({ width: 1000, height: 500 }));
  const r = new PageRenderer(loadBytes, loadPdfJs, env, decodeImage);
  return { r, loadBytes, getDocument, docs, renders, created, revoked, canvases, decodeImage };
}

describe('PageRenderer', () => {
  it('renders the same page+size once and serves the second call from cache', async () => {
    const s = setup();
    const a = await s.r.render(pg('p1'), 800);
    const b = await s.r.render(pg('p1'), 800);
    expect(b).toBe(a);
    expect(s.renders).toHaveLength(1);
  });

  it('scales the longer viewport edge to maxEdge and uses 1-based page numbers, no rotation', async () => {
    const s = setup({ vw: 200, vh: 400 });
    const img = await s.r.render(pg('p1', 'a.pdf', 2), 800);
    expect(s.renders[0].pageNumber).toBe(3);
    expect(s.renders[0].scale).toBe(2);
    expect(img.width).toBe(400);
    expect(img.height).toBe(800);
    expect(s.canvases[0]).toEqual({ w: 400, h: 800 });
  });

  it('renders again for a different maxEdge', async () => {
    const s = setup();
    await s.r.render(pg('p1'), 800);
    await s.r.render(pg('p1'), 400);
    expect(s.renders).toHaveLength(2);
  });

  it('opens the document once for two pages of one path', async () => {
    const s = setup();
    await s.r.render(pg('p1', 'a.pdf', 0), 800);
    await s.r.render(pg('p2', 'a.pdf', 1), 800);
    expect(s.getDocument).toHaveBeenCalledTimes(1);
    expect(s.loadBytes).toHaveBeenCalledTimes(1);
  });

  it('shares one in-flight promise for concurrent identical requests', async () => {
    const s = setup();
    const [a, b] = await Promise.all([s.r.render(pg('p1'), 800), s.r.render(pg('p1'), 800)]);
    expect(a).toBe(b);
    expect(s.renders).toHaveLength(1);
  });

  it('evicts the oldest beyond 60 entries and revokes its URL', async () => {
    const s = setup();
    const first = await s.r.render(pg('p0'), 800);
    for (let i = 1; i <= 60; i++) await s.r.render(pg(`p${i}`, 'a.pdf', i), 800);
    expect(s.revoked).toEqual([first.url]);
    await s.r.render(pg('p0'), 800);
    expect(s.renders).toHaveLength(62);
  });

  it('keeps recently used entries (LRU)', async () => {
    const s = setup();
    const first = await s.r.render(pg('p0'), 800);
    for (let i = 1; i < 60; i++) await s.r.render(pg(`p${i}`, 'a.pdf', i), 800);
    await s.r.render(pg('p0'), 800); // touch
    await s.r.render(pg('p60', 'a.pdf', 60), 800);
    expect(s.revoked).not.toContain(first.url);
    expect(s.revoked).toHaveLength(1);
  });

  it('dispose revokes all urls, destroys documents and makes later calls reject', async () => {
    const s = setup();
    const a = await s.r.render(pg('p1', 'a.pdf'), 800);
    const b = await s.r.render(pg('p2', 'b.pdf'), 800);
    s.r.dispose();
    expect(s.revoked.sort()).toEqual([a.url, b.url].sort());
    expect(s.docs.every((d) => d.destroy.mock.calls.length === 1)).toBe(true);
    await expect(s.r.render(pg('p1'), 800)).rejects.toThrow();
  });

  it('rejects only the failing request and does not cache the failure', async () => {
    const failPaths = new Set(['bad.pdf']);
    const s = setup({ failPaths });
    await expect(s.r.render(pg('x', 'bad.pdf'), 800)).rejects.toThrow('boom');
    await expect(s.r.render(pg('p1', 'a.pdf'), 800)).resolves.toBeTruthy();
    failPaths.clear();
    await expect(s.r.render(pg('x', 'bad.pdf'), 800)).resolves.toBeTruthy();
  });

  it('image pages: object URL from bytes, scaled to maxEdge, never upscaled', async () => {
    const s = setup();
    const a = await s.r.render(pg('i1', 'scan.JPG', 0, 'image'), 500);
    expect(a.width).toBe(500);
    expect(a.height).toBe(250);
    const b = await s.r.render(pg('i2', 'scan.png', 0, 'image'), 5000);
    expect(b.width).toBe(1000);
    expect(b.height).toBe(500);
    expect(s.getDocument).not.toHaveBeenCalled();
    expect(s.created).toHaveLength(2);
  });
});
