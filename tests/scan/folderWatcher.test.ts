import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setTimeout as nodeSetTimeout } from 'timers';
import { createFolderWatcher, type FolderWatcher, type WatcherOptions } from '../../src/scan/folderWatcher';

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
});
