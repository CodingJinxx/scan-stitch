import { deflateSync } from 'node:zlib';
import { PDFDocument, StandardFonts, degrees } from 'pdf-lib';

/** Build a PDF whose pages carry a text label. Optional per-page /Rotate. */
export async function makePdf(
  labels: string[],
  opts: { rotate?: number[]; size?: [number, number] } = {},
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  labels.forEach((label, i) => {
    const page = doc.addPage(opts.size ?? [200, 300]);
    page.drawText(label, { x: 20, y: 150, size: 18, font });
    const r = opts.rotate?.[i];
    if (r) page.setRotation(degrees(r));
  });
  return doc.save();
}

export async function makeEncryptedLookingPdf(): Promise<Uint8Array> {
  // A minimal file with an /Encrypt entry in the trailer; pdf-lib refuses it without ignoreEncryption.
  const text = [
    '%PDF-1.4',
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]>>endobj',
    '4 0 obj<</Filter/Standard/V 1/R 2/O(aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa)/U(bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb)/P -4>>endobj',
    'trailer<</Root 1 0 R/Size 5/Encrypt 4 0 R/ID[<00><00>]>>',
    '%%EOF',
  ].join('\n');
  return new TextEncoder().encode(text);
}

function u16be(n: number): number[] {
  return [(n >> 8) & 0xff, n & 0xff];
}

function segment(marker: number, payload: number[]): number[] {
  return [0xff, marker, ...u16be(payload.length + 2), ...payload];
}

const ascii = (s: string): number[] => Array.from(s, (c) => c.charCodeAt(0));

export interface JpegOpts {
  orientation?: number;
  /** JFIF density; units 1 = dpi, 2 = dpcm. */
  jfif?: { units: number; x: number; y: number };
  /** EXIF XResolution in dpi (ResolutionUnit inch). */
  exifDpi?: number;
}

/** Minimal JPEG structure (SOI, APPn, SOF0, SOS, EOI). pdf-lib only reads the header. */
export function makeJpeg(width: number, height: number, opts: JpegOpts = {}): Uint8Array {
  const out: number[] = [0xff, 0xd8];
  if (opts.jfif) {
    out.push(
      ...segment(0xe0, [...ascii('JFIF'), 0, 1, 1, opts.jfif.units, ...u16be(opts.jfif.x), ...u16be(opts.jfif.y), 0, 0]),
    );
  }
  if (opts.orientation !== undefined || opts.exifDpi !== undefined) {
    // Big-endian TIFF: header, IFD0 at offset 8.
    const entries: number[][] = [];
    const extra: number[] = [];
    const count = (opts.orientation !== undefined ? 1 : 0) + (opts.exifDpi !== undefined ? 2 : 0);
    const dataStart = 8 + 2 + count * 12 + 4;
    if (opts.orientation !== undefined) {
      entries.push([...u16be(0x0112), ...u16be(3), 0, 0, 0, 1, ...u16be(opts.orientation), 0, 0]);
    }
    if (opts.exifDpi !== undefined) {
      const off = dataStart + extra.length;
      entries.push([...u16be(0x011a), ...u16be(5), 0, 0, 0, 1, 0, 0, ...u16be(off)]);
      extra.push(0, 0, ...u16be(opts.exifDpi), 0, 0, 0, 1);
      entries.push([...u16be(0x0128), ...u16be(3), 0, 0, 0, 1, ...u16be(2), 0, 0]);
    }
    const tiff = [
      ...ascii('MM'),
      ...u16be(0x2a),
      0,
      0,
      0,
      8,
      ...u16be(count),
      ...entries.flat(),
      0,
      0,
      0,
      0,
      ...extra,
    ];
    out.push(...segment(0xe1, [...ascii('Exif'), 0, 0, ...tiff]));
  }
  out.push(...segment(0xc0, [8, ...u16be(height), ...u16be(width), 1, 1, 0x11, 0]));
  out.push(...segment(0xda, [1, 1, 0, 0, 0x3f, 0]));
  out.push(0, 0xff, 0xd9);
  return Uint8Array.from(out);
}

let crcTable: number[] | undefined;
function crc32(buf: Uint8Array): number {
  if (!crcTable) {
    crcTable = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable.push(c >>> 0);
    }
  }
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const body = new Uint8Array(4 + data.length);
  body.set(ascii(type), 0);
  body.set(data, 4);
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set(body, 4);
  dv.setUint32(8 + data.length, crc32(body));
  return out;
}

/** RGBA (alpha=true) or RGB 8-bit PNG with a gradient and semi-transparent pixels. */
export function makePng(width: number, height: number, alpha = true): Uint8Array {
  const bpp = alpha ? 4 : 3;
  const raw = new Uint8Array(height * (1 + width * bpp));
  let p = 0;
  for (let y = 0; y < height; y++) {
    raw[p++] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      raw[p++] = (x * 255) / Math.max(1, width - 1);
      raw[p++] = (y * 255) / Math.max(1, height - 1);
      raw[p++] = 128;
      if (alpha) raw[p++] = (x + y) % 2 === 0 ? 255 : 80;
    }
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = alpha ? 6 : 2;
  const parts = [
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', new Uint8Array(deflateSync(raw))),
    chunk('IEND', new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of parts) {
    out.set(a, o);
    o += a.length;
  }
  return out;
}
