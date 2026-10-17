import { PDFDocument } from 'pdf-lib';
import type { MergeResult } from './merge';

export interface ReplaceIO {
  read(): Promise<Uint8Array>;
  write(bytes: Uint8Array): Promise<void>;
  saveBackup(bytes: Uint8Array): Promise<void>;
  removeBackup(): Promise<void>;
}

/**
 * Replace a file with a rebuilt version only after the result is verified.
 * The backup is saved first and kept on any failure; it is removed only after a successful write.
 */
export async function replaceWithVerify(
  io: ReplaceIO,
  build: (existing: Uint8Array) => Promise<MergeResult>,
  expectedPages: number,
): Promise<void> {
  const existing = await io.read();
  await io.saveBackup(existing);
  const result = await build(existing);
  const reloaded = await PDFDocument.load(result.bytes);
  const actual = reloaded.getPageCount();
  if (actual !== expectedPages || actual !== result.pageCount) {
    throw new Error(
      `Verification failed: expected ${expectedPages} pages, merged file has ${actual} (reported ${result.pageCount}). Original left untouched.`,
    );
  }
  await io.write(result.bytes);
  try {
    await io.removeBackup();
  } catch {
    // A leftover backup is harmless; the replacement already succeeded.
  }
}
