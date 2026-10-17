import { PDFDocument } from 'pdf-lib';
import { sanitizeFileName, uniqueName } from '../core/template';
import { AppendTargetError, MergeSourceError, mergePages, type MergeResult, type MergeSource } from '../pdf/merge';
import { replaceWithVerify, type ReplaceIO } from '../pdf/safeReplace';
import type { PageRef } from '../types';

/** Save orchestration for the review screen. Pure: all IO is injected (no Obsidian imports). */

/** A failure with a message meant for the user. */
export class SaveError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SaveError';
  }
}

export interface SaveVault {
  /** Whether a file or folder exists at this vault path (ideally case-insensitive). */
  exists(path: string): boolean;
  /** Create the folder (and its parents) if it does not exist. */
  ensureFolder(path: string): Promise<void>;
  /** Create a new file; must fail rather than overwrite. */
  createBinary(path: string, bytes: Uint8Array): Promise<void>;
}

export interface SaveDeps {
  /** Pages in review order. */
  pages: PageRef[];
  /** Read a scanned file from disk. Called once per distinct path. */
  readSource: (path: string) => Promise<Uint8Array>;
  /** Vault folder for a new file; '' or '/' is the vault root. Ignored in append mode. */
  destinationFolder: string;
  /** User-editable name without extension. Ignored in append mode. */
  filename: string;
  /** Vault path of the PDF to append to, or null for a new file. */
  appendTarget: string | null;
  vault: SaveVault;
  /** IO for the append target (read, write, backup). Required in append mode. */
  appendIO?: ReplaceIO;
  /** Where `appendIO.saveBackup` keeps the original, named in the error if the write fails. */
  appendBackupPath?: string;
  /** Injectable for tests; defaults to `mergePages`. */
  merge?: (sources: MergeSource[], appendTo?: Uint8Array) => Promise<MergeResult>;
}

export interface SaveResult {
  /** Vault path of the written file. */
  path: string;
  /** Pages in the resulting file. */
  pageCount: number;
  /** Pages added by this save. */
  added: number;
}

function baseName(path: string): string {
  return path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function pageError(position: number, path: string, cause: unknown): SaveError {
  return new SaveError(`Page ${position + 1} (${baseName(path)}) could not be read.`, { cause });
}

function normalizeFolder(folder: string): string {
  return folder
    .replace(/\\/g, '/')
    .split('/')
    .filter((p) => p !== '')
    .join('/');
}

function cleanName(raw: string): string {
  return sanitizeFileName(raw.trim().replace(/\.pdf$/i, ''));
}

/** Reads each distinct source once, so every page of one file shares one bytes instance. */
async function buildSources(pages: PageRef[], readSource: SaveDeps['readSource']): Promise<MergeSource[]> {
  const bytesByPath = new Map<string, Uint8Array>();
  const out: MergeSource[] = [];
  for (const [i, p] of pages.entries()) {
    let bytes = bytesByPath.get(p.path);
    if (!bytes) {
      try {
        bytes = await readSource(p.path);
      } catch (e) {
        throw pageError(i, p.path, e);
      }
      bytesByPath.set(p.path, bytes);
    }
    out.push({ bytes, kind: p.kind, pageIndex: p.pageIndex, rotation: p.rotation });
  }
  return out;
}

function targetReason(e: unknown): string {
  return /encrypted/i.test(messageOf(e)) ? 'is encrypted' : 'is corrupt or unreadable';
}

async function countPages(bytes: Uint8Array): Promise<number> {
  try {
    return (await PDFDocument.load(bytes, { updateMetadata: false })).getPageCount();
  } catch (e) {
    throw new AppendTargetError(`The append target PDF ${targetReason(e)}.`, { cause: e });
  }
}

export async function savePages(deps: SaveDeps): Promise<SaveResult> {
  const { pages } = deps;
  if (pages.length === 0) throw new SaveError('There are no pages to save.');
  const merge = deps.merge ?? mergePages;

  const mapMergeError = (e: unknown): never => {
    if (e instanceof MergeSourceError) {
      const p = pages[e.sourceIndex];
      if (p) throw pageError(e.sourceIndex, p.path, e);
    }
    throw e;
  };

  if (deps.appendTarget !== null) {
    const target = deps.appendTarget;
    const name = baseName(target);
    const io = deps.appendIO;
    if (!io) throw new SaveError(`Could not append to ${name}: no access to the file.`);
    try {
      const sources = await buildSources(pages, deps.readSource);
      const existing = await io.read();
      const existingCount = await countPages(existing);
      const expected = existingCount + pages.length;
      // Hand replaceWithVerify the bytes already read, so the file is read once.
      const once: ReplaceIO = {
        ...io,
        read: () => Promise.resolve(existing),
        write: async (bytes) => {
          try {
            await io.write(bytes);
          } catch (e) {
            const where = deps.appendBackupPath ? ` A copy of the original was kept at ${deps.appendBackupPath}.` : '';
            throw new SaveError(`Could not append to ${name}: ${messageOf(e).replace(/\.$/, '')}.${where}`, { cause: e });
          }
        },
      };
      await replaceWithVerify(once, (bytes) => merge(sources, bytes).catch(mapMergeError), expected);
      return { path: target, pageCount: expected, added: pages.length };
    } catch (e) {
      if (e instanceof SaveError) throw e;
      if (e instanceof AppendTargetError) {
        throw new SaveError(`Could not append to ${name}: the PDF ${targetReason(e)}. The original file was not changed.`, {
          cause: e,
        });
      }
      throw new SaveError(`Could not append to ${name}: ${messageOf(e)}`, { cause: e });
    }
  }

  const folder = normalizeFolder(deps.destinationFolder);
  const join = (n: string): string => (folder === '' ? `${n}.pdf` : `${folder}/${n}.pdf`);
  const sources = await buildSources(pages, deps.readSource);
  let result: MergeResult;
  try {
    result = await merge(sources).catch(mapMergeError);
  } catch (e) {
    if (e instanceof SaveError) throw e;
    throw new SaveError(`Could not build the PDF: ${messageOf(e)}`, { cause: e });
  }
  try {
    if (folder !== '') await deps.vault.ensureFolder(folder);
    const path = join(uniqueName(cleanName(deps.filename), (n) => deps.vault.exists(join(n))));
    await deps.vault.createBinary(path, result.bytes);
    return { path, pageCount: result.pageCount, added: pages.length };
  } catch (e) {
    throw new SaveError(`Could not save the PDF: ${messageOf(e)}`, { cause: e });
  }
}
