import { PDFDocument, degrees } from 'pdf-lib';
import type { PageKind, Rotation } from '../types';

export interface MergeSource { bytes: Uint8Array; kind: PageKind; pageIndex: number; rotation: Rotation; }
export interface MergeResult { bytes: Uint8Array; pageCount: number; }

/** The append target is encrypted, corrupt or otherwise unreadable. */
export class AppendTargetError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AppendTargetError';
  }
}

const DEFAULT_DPI = 150;

interface ImageMeta { orientation: number; dpi: number | null; }

function isPng(b: Uint8Array): boolean {
  return b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
}

function isJpeg(b: Uint8Array): boolean {
  return b.length > 3 && b[0] === 0xff && b[1] === 0xd8;
}

function validDpi(v: number): number | null {
  return Number.isFinite(v) && v > 0 ? v : null;
}

function ascii(b: Uint8Array, off: number, s: string): boolean {
  for (let i = 0; i < s.length; i++) if (b[off + i] !== s.charCodeAt(i)) return false;
  return true;
}

/** Parse EXIF TIFF block: orientation, X resolution (dpi). Bounds-checked; returns defaults on trouble. */
function parseExif(b: Uint8Array, start: number, end: number): { orientation: number; dpi: number | null } {
  const res = { orientation: 1, dpi: null as number | null };
  if (end - start < 8) return res;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const le = b[start] === 0x49;
  if (!le && b[start] !== 0x4d) return res;
  const u16 = (o: number): number => dv.getUint16(o, le);
  const u32 = (o: number): number => dv.getUint32(o, le);
  const ifd = start + u32(start + 4);
  if (ifd + 2 > end) return res;
  const n = u16(ifd);
  let xres: number | null = null;
  let unit = 2;
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > end) break;
    const tag = u16(e);
    const type = u16(e + 2);
    if (tag === 0x0112 && type === 3) {
      const o = u16(e + 8);
      if (o >= 1 && o <= 8) res.orientation = o;
    } else if (tag === 0x0128 && type === 3) {
      unit = u16(e + 8);
    } else if (tag === 0x011a && type === 5) {
      const off = start + u32(e + 8);
      if (off + 8 <= end) {
        const den = u32(off + 4);
        if (den !== 0) xres = u32(off) / den;
      }
    }
  }
  if (xres !== null) res.dpi = validDpi(unit === 3 ? xres * 2.54 : xres);
  return res;
}

function readJpegMeta(b: Uint8Array): ImageMeta {
  let orientation = 1;
  let exifDpi: number | null = null;
  let jfifDpi: number | null = null;
  let p = 2;
  while (p + 4 <= b.length && b[p] === 0xff) {
    const marker = b[p + 1];
    if (marker === 0xff) { p++; continue; }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { p += 2; continue; }
    if (marker === 0xda || marker === 0xd9) break;
    const len = (b[p + 2] << 8) | b[p + 3];
    const body = p + 4;
    const end = Math.min(p + 2 + len, b.length);
    if (marker === 0xe0 && ascii(b, body, 'JFIF\0') && body + 12 <= end) {
      const units = b[body + 7];
      const x = (b[body + 8] << 8) | b[body + 9];
      if (units === 1) jfifDpi = validDpi(x);
      else if (units === 2) jfifDpi = validDpi(x * 2.54);
    } else if (marker === 0xe1 && ascii(b, body, 'Exif\0\0')) {
      const ex = parseExif(b, body + 6, end);
      orientation = ex.orientation;
      exifDpi = ex.dpi;
    }
    p += 2 + len;
  }
  return { orientation, dpi: exifDpi ?? jfifDpi };
}

function readPngMeta(b: Uint8Array): ImageMeta {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let p = 8;
  while (p + 12 <= b.length) {
    const len = dv.getUint32(p);
    if (ascii(b, p + 4, 'pHYs') && len >= 9) {
      const ppm = dv.getUint32(p + 8);
      return { orientation: 1, dpi: b[p + 16] === 1 ? validDpi(ppm * 0.0254) : null };
    }
    if (ascii(b, p + 4, 'IDAT')) break;
    p += 12 + len;
  }
  return { orientation: 1, dpi: null };
}

/** Rotation implied by an EXIF orientation (mirroring cannot be expressed via /Rotate and is ignored). */
function exifRotation(o: number): number {
  switch (o) {
    case 3: case 4: return 180;
    case 5: case 6: return 90;
    case 7: case 8: return 270;
    default: return 0;
  }
}

async function addImagePage(out: PDFDocument, src: MergeSource): Promise<void> {
  let meta: ImageMeta;
  let image;
  if (isPng(src.bytes)) {
    meta = readPngMeta(src.bytes);
    image = await out.embedPng(src.bytes);
  } else if (isJpeg(src.bytes)) {
    meta = readJpegMeta(src.bytes);
    image = await out.embedJpg(src.bytes);
  } else {
    throw new Error('Unsupported image format (expected JPEG or PNG)');
  }
  const dpi = meta.dpi ?? DEFAULT_DPI;
  // The page keeps the raw pixel orientation; EXIF orientation 5-8 swaps the displayed
  // width/height via the implied /Rotate, so the image itself is never re-sampled.
  const w = (image.width * 72) / dpi;
  const h = (image.height * 72) / dpi;
  const page = out.addPage([w, h]);
  page.drawImage(image, { x: 0, y: 0, width: w, height: h });
  page.setRotation(degrees((exifRotation(meta.orientation) + src.rotation) % 360));
}

async function addPdfPage(out: PDFDocument, src: MergeSource): Promise<void> {
  const doc = await PDFDocument.load(src.bytes);
  if (src.pageIndex < 0 || src.pageIndex >= doc.getPageCount()) {
    throw new Error(`Page ${src.pageIndex} does not exist in source PDF`);
  }
  const [copied] = await out.copyPages(doc, [src.pageIndex]);
  const page = out.addPage(copied);
  page.setRotation(degrees((page.getRotation().angle + src.rotation) % 360));
}

export async function mergePages(sources: MergeSource[], appendTo?: Uint8Array): Promise<MergeResult> {
  let out: PDFDocument;
  if (appendTo) {
    try {
      out = await PDFDocument.load(appendTo, { updateMetadata: false });
    } catch (e) {
      throw new AppendTargetError('The append target PDF is encrypted, corrupt or unreadable.', { cause: e });
    }
  } else {
    out = await PDFDocument.create();
  }
  // Sequential on purpose: keeps memory bounded for large scan batches.
  for (const src of sources) {
    if (src.kind === 'image') await addImagePage(out, src);
    else await addPdfPage(out, src);
  }
  const bytes = await out.save();
  return { bytes, pageCount: out.getPageCount() };
}
