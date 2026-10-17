import { describe, expect, it } from 'vitest';
import { PDFArray, PDFDocument, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import { AppendTargetError, mergePages, type MergeSource } from '../../src/pdf/merge';
import { makeEncryptedLookingPdf, makeJpeg, makePdf, makePng } from '../fixtures/builders';

const pdfSrc = (bytes: Uint8Array, pageIndex = 0, rotation: MergeSource['rotation'] = 0): MergeSource => ({
  bytes,
  kind: 'pdf',
  pageIndex,
  rotation,
});
const imgSrc = (bytes: Uint8Array, rotation: MergeSource['rotation'] = 0): MergeSource => ({
  bytes,
  kind: 'image',
  pageIndex: 0,
  rotation,
});

async function pageSizes(bytes: Uint8Array): Promise<Array<{ w: number; h: number; rot: number }>> {
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map((p) => ({ w: p.getWidth(), h: p.getHeight(), rot: p.getRotation().angle }));
}

describe('mergePages', () => {
  it('merges three single-page PDFs in order', async () => {
    const a = await makePdf(['A'], { size: [100, 100] });
    const b = await makePdf(['B'], { size: [200, 200] });
    const c = await makePdf(['C'], { size: [300, 300] });
    const res = await mergePages([pdfSrc(a), pdfSrc(b), pdfSrc(c)]);
    expect(res.pageCount).toBe(3);
    const sizes = await pageSizes(res.bytes);
    expect(sizes.map((s) => s.w)).toEqual([100, 200, 300]);
  });

  it('adds manual rotation to an existing /Rotate modulo 360', async () => {
    const a = await makePdf(['A'], { rotate: [90] });
    const res = await mergePages([pdfSrc(a, 0, 90)]);
    expect((await pageSizes(res.bytes))[0].rot).toBe(180);
    const b = await makePdf(['B'], { rotate: [270] });
    const res2 = await mergePages([pdfSrc(b, 0, 180)]);
    expect((await pageSizes(res2.bytes))[0].rot).toBe(90);
  });

  it('honours pageIndex of a multi-page source', async () => {
    const multi = await makePdf(['x', 'y', 'z'], { rotate: [0, 0, 0] });
    const doc = await PDFDocument.load(multi);
    doc.getPage(1).setSize(111, 222);
    const res = await mergePages([pdfSrc(await doc.save(), 1)]);
    expect(res.pageCount).toBe(1);
    const s = (await pageSizes(res.bytes))[0];
    expect([s.w, s.h]).toEqual([111, 222]);
  });

  it('sizes a JPEG page from the file DPI (150 dpi, 1500x1000 px -> 720x480 pt)', async () => {
    const jpg = makeJpeg(1500, 1000, { jfif: { units: 1, x: 150, y: 150 } });
    const res = await mergePages([imgSrc(jpg)]);
    expect(res.pageCount).toBe(1);
    expect(await pageSizes(res.bytes)).toEqual([{ w: 720, h: 480, rot: 0 }]);
  });

  it('falls back to 150 dpi, honours dpcm and EXIF resolution', async () => {
    const none = await mergePages([imgSrc(makeJpeg(1500, 1000))]);
    expect((await pageSizes(none.bytes))[0].w).toBeCloseTo(720);
    const cm = await mergePages([imgSrc(makeJpeg(1500, 1000, { jfif: { units: 2, x: 118, y: 118 } }))]);
    expect((await pageSizes(cm.bytes))[0].w).toBeCloseTo((1500 * 72) / (118 * 2.54), 3);
    const ex = await mergePages([imgSrc(makeJpeg(1500, 1000, { exifDpi: 300 }))]);
    expect((await pageSizes(ex.bytes))[0].w).toBeCloseTo(360);
  });

  it('applies EXIF orientation 6 (displayed dimensions swap, page rotated 90)', async () => {
    const jpg = makeJpeg(1500, 1000, { orientation: 6 });
    const res = await mergePages([imgSrc(jpg)]);
    const s = (await pageSizes(res.bytes))[0];
    expect(s.rot).toBe(90);
    // raw mediabox 720x480; displayed size after /Rotate 90 is 480 x 720 (dimensions swapped)
    expect([s.w, s.h]).toEqual([720, 480]);
    const manual = await mergePages([imgSrc(jpg, 90)]);
    expect((await pageSizes(manual.bytes))[0].rot).toBe(180);
    const o8 = await mergePages([imgSrc(makeJpeg(1500, 1000, { orientation: 8 }))]);
    expect((await pageSizes(o8.bytes))[0].rot).toBe(270);
    const o3 = await mergePages([imgSrc(makeJpeg(1500, 1000, { orientation: 3 }))]);
    expect((await pageSizes(o3.bytes))[0].rot).toBe(180);
  });

  it('embeds a PNG with alpha as one page', async () => {
    const res = await mergePages([imgSrc(makePng(20, 10, true))]);
    expect(res.pageCount).toBe(1);
  });

  it('appends after existing pages and leaves them untouched', async () => {
    const existing = await makePdf(['old1', 'old2'], { size: [111, 222] });
    const add = await makePdf(['new'], { size: [300, 300] });
    const res = await mergePages([pdfSrc(add)], existing);
    expect(res.pageCount).toBe(3);
    const sizes = await pageSizes(res.bytes);
    expect(sizes.map((s) => s.w)).toEqual([111, 111, 300]);
    const before = await PDFDocument.load(existing);
    const after = await PDFDocument.load(res.bytes);
    const content = (d: PDFDocument): number[] => {
      const arr = d.getPage(0).node.Contents();
      const out: number[] = [];
      if (arr instanceof PDFArray) {
        for (let i = 0; i < arr.size(); i++) {
          const st = arr.lookup(i, PDFRawStream);
          out.push(...decodePDFRawStream(st).decode());
        }
      }
      return out;
    };
    expect(content(after).length).toBeGreaterThan(0);
    expect(content(after)).toEqual(content(before));
  });

  it('throws AppendTargetError for garbage or encrypted appendTo', async () => {
    const add = await makePdf(['new']);
    await expect(mergePages([pdfSrc(add)], new TextEncoder().encode('not a pdf at all'))).rejects.toBeInstanceOf(
      AppendTargetError,
    );
    await expect(mergePages([pdfSrc(add)], new Uint8Array(0))).rejects.toBeInstanceOf(AppendTargetError);
    await expect(mergePages([pdfSrc(add)], await makeEncryptedLookingPdf())).rejects.toBeInstanceOf(
      AppendTargetError,
    );
  });
});
