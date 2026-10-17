import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setTimeout as nodeSetTimeout } from 'timers';
import { createFolderWatcher, type FolderWatcher, type WatcherOptions } from '../../src/scan/folderWatcher';

const counts = vi.hoisted(() => ({ readdir: 0, stats: [] as string[] }));

// Counting wrappers: ESM namespaces of node builtins cannot be spied on directly.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const wrapped = {
    ...actual,
    readdirSync: ((...args: unknown[]) => {
      counts.readdir++;
      return (actual.readdirSync as (...a: unknown[]) => unknown)(...args);
    }) as typeof actual.readdirSync,
    statSync: ((...args: unknown[]) => {
      counts.stats.push(String(args[0]));
      return (actual.statSync as (...a: unknown[]) => unknown)(...args);
    }) as typeof actual.statSync,
  };
  return { ...wrapped, default: wrapped };
});

const sleep = (ms: number) => new Promise((r) => nodeSetTimeout(r, ms));

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (cond()) return true;
    await sleep(10);
  }
  return cond();
}

let root: string;
let watchers: FolderWatcher[];
let files: string[];
let problems: Array<{ path?: string; reason: string }>;

function make(over: Partial<WatcherOptions> = {}): FolderWatcher {
  const w = createFolderWatcher({
    root,
    recursive: true,
    patterns: ['*.pdf'],
    since: Date.now() - 1000,
    stabilityDelayMs: 20,
    stabilityRetries: 2,
    pollIntervalMs: 50,
    ignore: () => false,
    onFile: (e) => files.push(e.path),
    onProblem: (e) => problems.push(e),
    ...over,
  });
  watchers.push(w);
  return w;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-stitch-'));
  watchers = [];
  files = [];
  problems = [];
});

afterEach(async () => {
  for (const w of watchers) w.stop();
  await sleep(30);
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe('folderWatcher', () => {
  it('fires once for a file written after start', async () => {
    make().start();
    const p = path.join(root, 'IMG_0001.pdf');
    fs.writeFileSync(p, 'data');
    expect(await waitFor(() => files.length >= 1)).toBe(true);
    await sleep(200);
    expect(files).toEqual([p]);
  });

  it('never fires for a file older than since', async () => {
    fs.writeFileSync(path.join(root, 'old.pdf'), 'data');
    await sleep(60);
    make({ since: Date.now() }).start();
    await sleep(300);
    expect(files).toEqual([]);
  });

  it('fires for a pre-existing file newer than since on start', async () => {
    const p = path.join(root, 'pre.pdf');
    fs.writeFileSync(p, 'data');
    make().start();
    expect(await waitFor(() => files.length === 1)).toBe(true);
    expect(files).toEqual([p]);
  });

  it('fires a growing file only after it stops growing', async () => {
    make({ stabilityDelayMs: 40, stabilityRetries: 2 }).start();
    const p = path.join(root, 'grow.pdf');
    fs.writeFileSync(p, 'a');
    for (let i = 0; i < 5; i++) {
      await sleep(15);
      fs.appendFileSync(p, 'b');
      expect(files).toEqual([]);
    }
    expect(await waitFor(() => files.length === 1)).toBe(true);
    expect(fs.readFileSync(p, 'utf8')).toBe('abbbbb');
    expect(files).toEqual([p]);
  });

  it('never fires a zero-byte file and reports unreadable once', async () => {
    make().start();
    const p = path.join(root, 'empty.pdf');
    fs.writeFileSync(p, '');
    expect(await waitFor(() => problems.some((x) => x.reason === 'unreadable'))).toBe(true);
    await sleep(300);
    expect(files).toEqual([]);
    expect(problems.filter((x) => x.reason === 'unreadable')).toEqual([{ path: p, reason: 'unreadable' }]);
  });

  it('retries a given-up file once its size changes', async () => {
    make().start();
    const p = path.join(root, 'late.pdf');
    fs.writeFileSync(p, '');
    expect(await waitFor(() => problems.length === 1)).toBe(true);
    fs.writeFileSync(p, 'now has content');
    expect(await waitFor(() => files.length === 1)).toBe(true);
    expect(files).toEqual([p]);
  });

  it('never fires an ignored file', async () => {
    make({ ignore: (p) => p.endsWith('skip.pdf') }).start();
    fs.writeFileSync(path.join(root, 'skip.pdf'), 'data');
    const keep = path.join(root, 'keep.pdf');
    fs.writeFileSync(keep, 'data');
    expect(await waitFor(() => files.length >= 1)).toBe(true);
    await sleep(200);
    expect(files).toEqual([keep]);
  });

  it('ignores non-matching extensions', async () => {
    make().start();
    fs.writeFileSync(path.join(root, 'notes.txt'), 'data');
    const p = path.join(root, 'a.pdf');
    fs.writeFileSync(p, 'data');
    expect(await waitFor(() => files.length >= 1)).toBe(true);
    await sleep(200);
    expect(files).toEqual([p]);
  });

  it('fires for a subfolder created after start', async () => {
    make().start();
    const dir = path.join(root, '2026_10_13');
    fs.mkdirSync(dir);
    const p = path.join(dir, 'IMG_0001.pdf');
    fs.writeFileSync(p, 'data');
    expect(await waitFor(() => files.length === 1)).toBe(true);
    expect(files).toEqual([p]);
  });

  it('fires twice for the same name in two day folders', async () => {
    fs.mkdirSync(path.join(root, '2026_06_29'));
    fs.mkdirSync(path.join(root, '2026_10_13'));
    make().start();
    const a = path.join(root, '2026_06_29', 'IMG_0001.pdf');
    const b = path.join(root, '2026_10_13', 'IMG_0001.pdf');
    fs.writeFileSync(a, 'one');
    fs.writeFileSync(b, 'two');
    expect(await waitFor(() => files.length === 2)).toBe(true);
    await sleep(200);
    expect([...files].sort()).toEqual([a, b].sort());
  });

  it('does not descend when recursive is false', async () => {
    make({ recursive: false }).start();
    fs.mkdirSync(path.join(root, 'sub'));
    fs.writeFileSync(path.join(root, 'sub', 'x.pdf'), 'data');
    const top = path.join(root, 'top.pdf');
    fs.writeFileSync(top, 'data');
    expect(await waitFor(() => files.length >= 1)).toBe(true);
    await sleep(200);
    expect(files).toEqual([top]);
  });

  it('reports root-missing then root-restored and keeps working', async () => {
    make().start();
    await sleep(100);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    expect(await waitFor(() => problems.some((x) => x.reason === 'root-missing'))).toBe(true);
    await sleep(200);
    expect(problems.filter((x) => x.reason === 'root-missing')).toHaveLength(1);
    fs.mkdirSync(root);
    expect(await waitFor(() => problems.some((x) => x.reason === 'root-restored'))).toBe(true);
    const p = path.join(root, 'after.pdf');
    fs.writeFileSync(p, 'data');
    expect(await waitFor(() => files.length === 1)).toBe(true);
    expect(files).toEqual([p]);
  });

  it('stop() ends events', async () => {
    const w = make();
    w.start();
    await sleep(100);
    w.stop();
    fs.writeFileSync(path.join(root, 'late.pdf'), 'data');
    await sleep(300);
    expect(files).toEqual([]);
    await w.rescan();
    expect(files).toEqual([]);
  });

  it('stop() during a stability check suppresses the emit', async () => {
    const w = make({ stabilityDelayMs: 100, stabilityRetries: 3 });
    w.start();
    fs.writeFileSync(path.join(root, 'mid.pdf'), 'data');
    await sleep(150);
    w.stop();
    await sleep(500);
    expect(files).toEqual([]);
  });

  it('coalesces a burst of writes into far fewer directory walks', async () => {
    make({ pollIntervalMs: 60000 }).start();
    await sleep(50);
    counts.readdir = 0;
    const N = 40;
    for (let i = 0; i < N; i++) {
      fs.writeFileSync(path.join(root, `b${i}.pdf`), 'data');
      await sleep(5);
    }
    expect(await waitFor(() => files.length === N, 5000)).toBe(true);
    expect(counts.readdir).toBeLessThan(N / 2);
  });

  it('does not re-stat files older than since on later passes', async () => {
    for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(root, `old${i}.pdf`), 'data');
    await sleep(60);
    const w = make({ since: Date.now(), pollIntervalMs: 60000 });
    w.start();
    await w.rescan();
    counts.stats = [];
    await w.rescan();
    await w.rescan();
    await w.rescan();
    const oldStats = counts.stats.filter((p) => p.includes('old'));
    expect(oldStats).toHaveLength(0);
  });

  it('reports a permanently zero-byte file once across many rescans, then emits after rewrite', async () => {
    const w = make({ pollIntervalMs: 60000 });
    const p = path.join(root, 'zero.pdf');
    fs.writeFileSync(p, '');
    w.start();
    for (let i = 0; i < 4; i++) await w.rescan();
    expect(problems.filter((x) => x.reason === 'unreadable')).toHaveLength(1);
    expect(files).toEqual([]);
    fs.writeFileSync(p, 'content');
    await w.rescan();
    expect(files).toEqual([p]);
  });

  it('keeps going when onFile throws', async () => {
    let calls = 0;
    make({
      onFile: (e) => {
        calls++;
        files.push(e.path);
        if (calls === 1) throw new Error('consumer bug');
      },
    }).start();
    fs.writeFileSync(path.join(root, 'a.pdf'), 'data');
    await sleep(150);
    const b = path.join(root, 'b.pdf');
    fs.writeFileSync(b, 'data');
    expect(await waitFor(() => files.includes(b))).toBe(true);
  });

  it('keeps going when onProblem throws', async () => {
    make({
      onProblem: () => {
        throw new Error('consumer bug');
      },
    }).start();
    fs.writeFileSync(path.join(root, 'z.pdf'), '');
    await sleep(200);
    const b = path.join(root, 'b.pdf');
    fs.writeFileSync(b, 'data');
    expect(await waitFor(() => files.includes(b))).toBe(true);
  });

  it('reports a locked file once, retries without re-reporting, and emits when it unlocks', async () => {
    let locked = true;
    const p = path.join(root, 'locked.pdf');
    const w = make({
      pollIntervalMs: 60000,
      probeReadable: () => {
        if (locked) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      },
    });
    fs.writeFileSync(p, 'data');
    w.start();
    for (let i = 0; i < 3; i++) await w.rescan();
    expect(files).toEqual([]);
    expect(problems.filter((x) => x.reason === 'unreadable')).toEqual([{ path: p, reason: 'unreadable' }]);
    locked = false;
    await w.rescan();
    expect(files).toEqual([p]);
    expect(problems.filter((x) => x.reason === 'unreadable')).toHaveLength(1);
  });
});
