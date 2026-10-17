import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setTimeout as nodeSetTimeout } from 'timers';
import { SessionController, type ControllerDeps } from '../../src/scan/sessionController';
import type { FolderWatcher, WatcherOptions } from '../../src/scan/folderWatcher';
import type { ScanStitchSettings, SessionData } from '../../src/types';

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => nodeSetTimeout(r, 0));
};

interface Fake extends FolderWatcher {
  opts: WatcherOptions;
  started: number;
  stopped: number;
  pending: { path: string; seenAt: number }[];
}

function makeSettings(): ScanStitchSettings {
  return {
    watchRoot: '/scans',
    includeSubfolders: true,
    patterns: ['*.pdf'],
    stabilityDelayMs: 10,
    stabilityRetries: 2,
    templates: [],
    defaultTemplate: '',
    recentLocations: [],
    session: null,
  };
}

const INIT = { destinationFolder: 'Dest', templateName: 'T', filename: 'out', appendTarget: null };

describe('SessionController', () => {
  let watchers: Fake[];
  let persisted: (SessionData | null)[];
  let notes: string[];
  let pageCounts: Record<string, number | Error>;
  let deps: ControllerDeps;
  let tmp: string;
  let preload: { path: string; seenAt: number }[];

  beforeEach(() => {
    watchers = [];
    preload = [];
    persisted = [];
    notes = [];
    pageCounts = {};
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ssc-'));
    deps = {
      settings: makeSettings,
      persist: async (s) => {
        persisted.push(s ? (JSON.parse(JSON.stringify(s)) as SessionData) : null);
      },
      countPdfPages: async (p) => {
        const v = pageCounts[p];
        if (v instanceof Error) throw v;
        return v ?? 1;
      },
      notify: (m) => notes.push(m),
      now: () => 1000,
      createWatcher: (opts) => {
        const w: Fake = {
          opts,
          started: 0,
          stopped: 0,
          pending: preload.splice(0),
          start() {
            w.started++;
          },
          stop() {
            w.stopped++;
          },
          async rescan() {
            for (const e of w.pending.splice(0)) if (!opts.ignore(e.path)) opts.onFile(e);
          },
        };
        watchers.push(w);
        return w;
      },
    };
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('start creates a scanning session, persists, and starts the watcher', async () => {
    const c = new SessionController(deps);
    c.start(INIT);
    await flush();
    expect(c.state?.data.phase).toBe('scanning');
    expect(c.state?.data.watchRoot).toBe('/scans');
    expect(c.state?.data.startedAt).toBe(1000);
    expect(persisted.at(-1)?.phase).toBe('scanning');
    expect(watchers[0].started).toBe(1);
    expect(watchers[0].opts.since).toBe(1000);
    expect(watchers[0].opts.recursive).toBe(true);
    expect(watchers[0].opts.patterns).toEqual(['*.pdf']);
  });

  it('start throws when a session already exists', () => {
    const c = new SessionController(deps);
    c.start(INIT);
    expect(() => c.start(INIT)).toThrow();
  });

  it('adds arriving files in order, images as one page', async () => {
    const c = new SessionController(deps);
    const changes = vi.fn();
    c.onChange(changes);
    c.start(INIT);
    pageCounts['/scans/a.pdf'] = 3;
    const o = watchers[0].opts;
    o.onFile({ path: '/scans/a.pdf', seenAt: 1 });
    o.onFile({ path: '/scans/b.jpg', seenAt: 2 });
    await flush();
    expect(c.state?.data.pages.map((p) => p.id)).toEqual(['/scans/a.pdf#0', '/scans/a.pdf#1', '/scans/a.pdf#2', '/scans/b.jpg#0']);
    expect(c.state?.data.pages[3].kind).toBe('image');
    expect(persisted.at(-1)?.pages).toHaveLength(4);
    expect(changes).toHaveBeenCalled();
  });

  it('corrupt PDF: notifies, adds nothing, later files still added', async () => {
    const c = new SessionController(deps);
    c.start(INIT);
    pageCounts['/scans/bad.pdf'] = new Error('corrupt');
    const o = watchers[0].opts;
    o.onFile({ path: '/scans/bad.pdf', seenAt: 1 });
    o.onFile({ path: '/scans/good.pdf', seenAt: 2 });
    await flush();
    expect(notes.some((n) => n.includes('bad.pdf'))).toBe(true);
    expect(c.state?.data.pages.map((p) => p.path)).toEqual(['/scans/good.pdf']);
    expect(o.ignore('/scans/bad.pdf')).toBe(true);
  });

  it('ignore covers discarded and known pages', async () => {
    const c = new SessionController(deps);
    c.start(INIT);
    const o = watchers[0].opts;
    o.onFile({ path: '/scans/a.pdf', seenAt: 1 });
    await flush();
    expect(o.ignore('/scans/a.pdf')).toBe(true);
    c.discardLast();
    expect(o.ignore('/scans/a.pdf')).toBe(true);
    expect(o.ignore('/scans/z.pdf')).toBe(false);
  });

  it('discardLast lowers the count and persists', async () => {
    const c = new SessionController(deps);
    c.start(INIT);
    const o = watchers[0].opts;
    o.onFile({ path: '/scans/a.pdf', seenAt: 1 });
    o.onFile({ path: '/scans/b.pdf', seenAt: 2 });
    await flush();
    c.discardLast();
    await flush();
    expect(c.state?.countFiles()).toBe(1);
    expect(persisted.at(-1)?.discardedPaths).toEqual(['/scans/b.pdf']);
  });

  it('endScanning goes to review and stops watcher; backToScanning restarts', async () => {
    const c = new SessionController(deps);
    c.start(INIT);
    c.endScanning();
    await flush();
    expect(c.state?.data.phase).toBe('review');
    expect(watchers[0].stopped).toBe(1);
    expect(persisted.at(-1)?.phase).toBe('review');
    c.backToScanning();
    expect(c.state?.data.phase).toBe('scanning');
    expect(watchers).toHaveLength(2);
    expect(watchers[1].started).toBe(1);
  });

  it('files arriving after endScanning are ignored', async () => {
    const c = new SessionController(deps);
    c.start(INIT);
    c.endScanning();
    watchers[0].opts.onFile({ path: '/scans/late.pdf', seenAt: 5 });
    await flush();
    expect(c.state?.data.pages).toHaveLength(0);
  });

  it('maps watcher problems to notifications', () => {
    const c = new SessionController(deps);
    c.start(INIT);
    const o = watchers[0].opts;
    o.onProblem({ path: '/scans/x.pdf', reason: 'unreadable' });
    o.onProblem({ reason: 'root-missing' });
    o.onProblem({ reason: 'root-restored' });
    expect(notes[0]).toContain('x.pdf');
    expect(notes[1]).toBe('Scanner folder is unavailable');
    expect(notes[2]).toBe('Scanner folder is back');
  });

  it('persists serially, last state wins, persist errors notify not throw', async () => {
    let active = 0;
    let maxActive = 0;
    const order: number[] = [];
    deps.persist = async (s) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => nodeSetTimeout(r, 5));
      order.push(s ? s.pages.length : -1);
      active--;
    };
    const c = new SessionController(deps);
    c.start(INIT);
    const o = watchers[0].opts;
    o.onFile({ path: '/scans/a.pdf', seenAt: 1 });
    o.onFile({ path: '/scans/b.pdf', seenAt: 2 });
    await new Promise((r) => nodeSetTimeout(r, 80));
    expect(maxActive).toBe(1);
    expect(order.at(-1)).toBe(2);

    deps.persist = async () => {
      throw new Error('disk full');
    };
    const c2 = new SessionController(deps);
    c2.start(INIT);
    await flush();
    expect(notes.some((n) => /save/i.test(n))).toBe(true);
  });

  it('commit persists direct edits and notifies; no-op without a session', async () => {
    const c = new SessionController(deps);
    const changes = vi.fn();
    c.onChange(changes);
    c.commit();
    await flush();
    expect(persisted).toHaveLength(0);
    expect(changes).not.toHaveBeenCalled();
    c.start(INIT);
    watchers[0].opts.onFile({ path: '/scans/a.pdf', seenAt: 1 });
    await flush();
    changes.mockClear();
    c.state?.rotate(['/scans/a.pdf#0'], 1);
    c.commit();
    await flush();
    expect(persisted.at(-1)?.pages[0].rotation).toBe(90);
    expect(changes).toHaveBeenCalled();
  });

  it('finish clears the session and persists null', async () => {
    const c = new SessionController(deps);
    c.start(INIT);
    await c.finish();
    expect(c.state).toBeNull();
    expect(persisted.at(-1)).toBeNull();
    expect(watchers[0].stopped).toBe(1);
    expect(() => c.start(INIT)).not.toThrow();
  });

  describe('resume', () => {
    function data(over: Partial<SessionData> = {}): SessionData {
      return {
        id: 's1',
        startedAt: 500,
        watchRoot: '/old-root',
        destinationFolder: 'D',
        templateName: 'T',
        filename: 'f',
        appendTarget: null,
        pages: [],
        discardedPaths: [],
        phase: 'scanning',
        ...over,
      };
    }

    it('skips missing files with one notice, keeps existing', async () => {
      const real = path.join(tmp, 'real.pdf');
      fs.writeFileSync(real, 'x');
      const page = (p: string, i: number) => ({ id: `${p}#${i}`, path: p, pageIndex: i, kind: 'pdf' as const, rotation: 0 as const, seenAt: 1 });
      const c = new SessionController(deps);
      await c.resume(
        data({ watchRoot: tmp, pages: [page(real, 0), page('/gone/a.pdf', 0), page('/gone/a.pdf', 1), page('/gone/b.pdf', 0)] }),
      );
      expect(c.state?.data.pages.map((p) => p.path)).toEqual([real]);
      expect(notes.filter((n) => n.includes('missing') || n.includes('no longer'))).toHaveLength(1);
      expect(watchers[0].opts.root).toBe(tmp);
    });

    it('rescans and adds newer files, not already known', async () => {
      const real = path.join(tmp, 'real.pdf');
      fs.writeFileSync(real, 'x');
      const page = { id: `${real}#0`, path: real, pageIndex: 0, kind: 'pdf' as const, rotation: 0 as const, seenAt: 1 };
      const c = new SessionController(deps);
      preload.push({ path: real, seenAt: 2 }, { path: '/scans/new.pdf', seenAt: 3 });
      await c.resume(data({ watchRoot: tmp, pages: [page] }));
      await flush();
      expect(c.state?.data.pages.map((x) => x.path)).toEqual([real, '/scans/new.pdf']);
    });

    it('drops malformed pages defensively', async () => {
      const c = new SessionController(deps);
      const bad = data({ pages: [null, 5, { id: 1 }, { path: 7 }] as unknown as SessionData['pages'] });
      await c.resume(bad);
      expect(c.state?.data.pages).toEqual([]);
    });

    it('survives wholly malformed input and persists null', async () => {
      const c = new SessionController(deps);
      await expect(c.resume(null as unknown as SessionData)).resolves.toBeUndefined();
      expect(c.state).toBeNull();
      expect(notes.length).toBeGreaterThan(0);
      expect(persisted).toEqual([null]);
    });

    const mkPage = (p: string) => ({ id: `${p}#0`, path: p, pageIndex: 0, kind: 'pdf' as const, rotation: 0 as const, seenAt: 1 });

    it('unavailable root keeps all pages, notifies once, persists, revalidates on restore', async () => {
      const real = path.join(tmp, 'real.pdf');
      fs.writeFileSync(real, 'x');
      const gone = path.join(tmp, 'gone.pdf');
      const c = new SessionController(deps);
      await c.resume(data({ watchRoot: path.join(tmp, 'nope'), pages: [mkPage(real), mkPage(gone)] }));
      await flush();
      expect(c.state?.data.pages).toHaveLength(2);
      expect(persisted.at(-1)?.pages).toHaveLength(2);
      watchers[0].opts.onProblem({ reason: 'root-missing' });
      expect(notes.filter((n) => n === 'Scanner folder is unavailable')).toHaveLength(1);
      watchers[0].opts.onProblem({ reason: 'root-restored' });
      await flush();
      expect(c.state?.data.pages.map((p) => p.path)).toEqual([real]);
      expect(persisted.at(-1)?.pages).toHaveLength(1);
    });

    it('review phase does not keep a watcher running', async () => {
      const c = new SessionController(deps);
      await c.resume(data({ phase: 'review' }));
      expect(c.state?.data.phase).toBe('review');
      expect(watchers).toHaveLength(0);
    });

    it('scanning phase leaves the watcher running', async () => {
      const c = new SessionController(deps);
      await c.resume(data());
      expect(watchers[0].started).toBe(1);
      expect(watchers[0].stopped).toBe(0);
    });

    it('throws if a session already exists', async () => {
      const c = new SessionController(deps);
      c.start(INIT);
      await expect(c.resume(data())).rejects.toThrow();
    });
  });
});
