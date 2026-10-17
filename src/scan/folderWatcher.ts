import * as fs from 'fs';
import * as path from 'path';
// Node's timers on purpose: the lint rule obsidianmd/prefer-window-timers forbids the globals
// and eslint-disable is not allowed, and the plugin is desktop-only so Node builtins are available.
import { setTimeout as nodeSetTimeout, clearTimeout as nodeClearTimeout, setInterval as nodeSetInterval, clearInterval as nodeClearInterval } from 'timers';
import { matchesAnyPattern } from '../core/patterns';

export interface WatcherOptions {
  root: string;
  recursive: boolean;
  patterns: string[];
  since: number;
  stabilityDelayMs: number;
  stabilityRetries: number;
  pollIntervalMs?: number;
  ignore: (path: string) => boolean;
  onFile: (e: { path: string; seenAt: number }) => void;
  onProblem: (e: { path?: string; reason: 'unreadable' | 'root-missing' | 'root-restored' }) => void;
  /** Read-only open probe; throws if the file is locked. Defaults to openSync/closeSync. Test seam. */
  probeReadable?: (path: string) => void;
}

export interface FolderWatcher {
  start(): void;
  stop(): void;
  rescan(): Promise<void>;
}

const DEFAULT_POLL_MS = 3000;
const EVENT_DEBOUNCE_MS = 150;
const TOO_OLD_MAX = 5000;
const LOCK_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);

function defaultProbe(file: string): void {
  const fd = fs.openSync(file, 'r');
  fs.closeSync(fd);
}

/**
 * Watches a scanner folder (read only: nothing is ever written, renamed or
 * deleted there). Uses fs.watch when it works plus a periodic rescan as the
 * polling fallback.
 */
export function createFolderWatcher(opts: WatcherOptions): FolderWatcher {
  const probe = opts.probeReadable ?? defaultProbe;
  const emitted = new Set<string>();
  const inFlight = new Map<string, Promise<void>>();
  // paths reported unreadable, with the size:mtime marker seen when giving up
  const gaveUp = new Map<string, string>();
  // locked paths already reported (retried every pass, never re-reported)
  const lockReported = new Set<string>();
  // paths whose birth/mtime is before `since`; skipped without a stat
  const tooOld = new Set<string>();
  const sleepers = new Set<{ timer: ReturnType<typeof setTimeout>; resolve: () => void }>();
  let running = false;
  let rootOk = true;
  let fsWatcher: fs.FSWatcher | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let scanning: Promise<void> | null = null;
  let dirty = false;

  function fireFile(file: string): void {
    try {
      opts.onFile({ path: file, seenAt: Date.now() });
    } catch {
      // the consumer owns its errors
    }
  }

  function fireProblem(e: { path?: string; reason: 'unreadable' | 'root-missing' | 'root-restored' }): void {
    try {
      opts.onProblem(e);
    } catch {
      // the consumer owns its errors
    }
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const entry = {
        timer: nodeSetTimeout(() => {
          sleepers.delete(entry);
          resolve();
        }, ms),
        resolve,
      };
      sleepers.add(entry);
    });
  }

  function rootAccessible(): boolean {
    try {
      return fs.statSync(opts.root).isDirectory();
    } catch {
      return false;
    }
  }

  function closeFsWatcher(): void {
    if (fsWatcher) {
      try {
        fsWatcher.close();
      } catch {
        // ignore
      }
      fsWatcher = null;
    }
  }

  function scheduleRescan(): void {
    if (!running || debounceTimer) return;
    debounceTimer = nodeSetTimeout(() => {
      debounceTimer = null;
      rescan().catch(() => {});
    }, EVENT_DEBOUNCE_MS);
  }

  function openFsWatcher(): void {
    if (fsWatcher || !running) return;
    try {
      const w = fs.watch(opts.root, { recursive: opts.recursive }, scheduleRescan);
      w.on('error', () => {
        if (fsWatcher === w) closeFsWatcher();
      });
      fsWatcher = w;
    } catch {
      fsWatcher = null; // polling still covers us
    }
  }

  function walk(dir: string, out: string[]): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (opts.recursive) walk(full, out);
      } else if (e.isFile() && matchesAnyPattern(e.name, opts.patterns)) {
        out.push(full);
      }
    }
  }

  function markerOf(st: fs.Stats): string {
    return `${st.size}:${st.mtimeMs}`;
  }

  function giveUp(file: string, marker: string): void {
    gaveUp.set(file, marker);
    fireProblem({ path: file, reason: 'unreadable' });
  }

  /** True once the file is non-zero, stable and openable; false if not (problem reported where relevant). */
  async function waitStable(file: string): Promise<boolean> {
    const retries = Math.max(1, opts.stabilityRetries);
    const maxChecks = Math.max(retries * 20, 100);
    let prev = -1;
    let stable = 0;
    let last: fs.Stats | null = null;
    for (let i = 0; i < maxChecks; i++) {
      await sleep(opts.stabilityDelayMs);
      if (!running) return false;
      try {
        last = fs.statSync(file);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false; // vanished
        giveUp(file, 'stat-error');
        return false;
      }
      if (last.size === prev) stable++;
      else {
        stable = 0;
        prev = last.size;
      }
      if (stable >= retries) {
        if (last.size === 0) {
          giveUp(file, markerOf(last));
          return false;
        }
        try {
          probe(file);
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === 'ENOENT') return false;
          if (code !== undefined && LOCK_CODES.has(code)) {
            // locked: report once, then retry on later passes without re-reporting
            if (!lockReported.has(file)) {
              lockReported.add(file);
              fireProblem({ path: file, reason: 'unreadable' });
            }
            return false;
          }
          giveUp(file, markerOf(last));
          return false;
        }
        return true;
      }
    }
    giveUp(file, last ? markerOf(last) : 'unknown');
    return false;
  }

  async function processFile(file: string): Promise<void> {
    try {
      if ((await waitStable(file)) && running && !emitted.has(file)) {
        emitted.add(file);
        gaveUp.delete(file);
        lockReported.delete(file);
        fireFile(file);
      }
    } catch {
      // never let one file break the loop
    } finally {
      inFlight.delete(file);
    }
  }

  /** One walk; starts stability checks but does not wait for them. */
  function pass(): void {
    const ok = rootAccessible();
    if (!ok) {
      if (rootOk) {
        rootOk = false;
        closeFsWatcher();
        fireProblem({ reason: 'root-missing' });
      }
      return;
    }
    if (!rootOk) {
      rootOk = true;
      tooOld.clear();
      fireProblem({ reason: 'root-restored' });
    }
    openFsWatcher();

    const found: string[] = [];
    walk(opts.root, found);
    for (const file of found) {
      if (emitted.has(file) || inFlight.has(file) || tooOld.has(file)) continue;
      let st: fs.Stats;
      try {
        st = fs.statSync(file);
      } catch {
        continue;
      }
      if (Math.max(st.birthtimeMs, st.mtimeMs) < opts.since) {
        if (tooOld.size >= TOO_OLD_MAX) tooOld.clear();
        tooOld.add(file);
        continue;
      }
      if (opts.ignore(file)) continue;
      const gave = gaveUp.get(file);
      if (gave !== undefined) {
        if (gave === markerOf(st)) continue;
        gaveUp.delete(file);
      }
      inFlight.set(file, processFile(file));
    }
  }

  /** Single-flight: calls during a pass cause exactly one follow-up pass. */
  function scan(): Promise<void> {
    if (scanning) {
      dirty = true;
      return scanning;
    }
    const run = (async () => {
      do {
        dirty = false;
        pass();
        await Promise.resolve(); // let events that arrived mid-pass set `dirty`
      } while (dirty && running);
    })().finally(() => {
      scanning = null;
    });
    scanning = run;
    return run;
  }

  async function rescan(): Promise<void> {
    if (!running) return;
    await scan();
    await Promise.all([...inFlight.values()]);
  }

  return {
    start(): void {
      if (running) return;
      running = true;
      rootOk = rootAccessible();
      if (!rootOk) fireProblem({ reason: 'root-missing' });
      else openFsWatcher();
      pollTimer = nodeSetInterval(() => {
        rescan().catch(() => {});
      }, opts.pollIntervalMs ?? DEFAULT_POLL_MS);
      rescan().catch(() => {});
    },
    stop(): void {
      running = false;
      closeFsWatcher();
      if (pollTimer) {
        nodeClearInterval(pollTimer);
        pollTimer = null;
      }
      if (debounceTimer) {
        nodeClearTimeout(debounceTimer);
        debounceTimer = null;
      }
      for (const s of sleepers) {
        nodeClearTimeout(s.timer);
        s.resolve();
      }
      sleepers.clear();
    },
    rescan,
  };
}
