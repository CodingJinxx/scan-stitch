import { describe, expect, it, vi } from 'vitest';
import { PDFArray, PDFName, PDFNumber, PDFDocument, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import { AppendTargetError, MergeSourceError, mergePages, type MergeSource } from '../../src/pdf/merge';
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

  it('normalises a negative existing /Rotate', async () => {
    const a = await makePdf(['A']);
    const doc = await PDFDocument.load(a);
    doc.getPage(0).node.set(PDFName.of('Rotate'), PDFNumber.of(-90));
    const res = await mergePages([pdfSrc(await doc.save(), 0, 90)]);
    expect((await pageSizes(res.bytes))[0].rot).toBe(0);
  });

  it('ignores mirrored EXIF orientations (no rotation)', async () => {
    for (const o of [2, 4, 5, 7]) {
      const res = await mergePages([imgSrc(makeJpeg(100, 50, { orientation: o }))]);
      expect((await pageSizes(res.bytes))[0].rot).toBe(0);
    }
  });

  it('parses each distinct source once and handles non-sequential pageIndex', async () => {
    const five = await PDFDocument.create();
    for (let i = 0; i < 5; i++) five.addPage([100 + i, 100]);
    const bytes = await five.save();
    const spy = vi.spyOn(PDFDocument, 'load');
    try {
      const res = await mergePages([pdfSrc(bytes, 4), pdfSrc(bytes, 0), pdfSrc(bytes, 2)]);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(res.pageCount).toBe(3);
      expect((await pageSizes(res.bytes)).map((s) => s.w)).toEqual([104, 100, 102]);
    } finally {
      spy.mockRestore();
    }
  });

  it('reports the failing source index', async () => {
    const good = await makePdf(['A']);
    const bad = new TextEncoder().encode('garbage');
    const err = await mergePages([pdfSrc(good), imgSrc(makeJpeg(10, 10)), pdfSrc(bad)]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MergeSourceError);
    expect((err as MergeSourceError).sourceIndex).toBe(2);
    await expect(mergePages([pdfSrc(good, 3)])).rejects.toThrow(/page 3 does not exist/);
    await expect(mergePages([pdfSrc(good, 3)])).rejects.toBeInstanceOf(MergeSourceError);
    const img = await mergePages([imgSrc(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]))]).catch((e: unknown) => e);
    expect(img).toBeInstanceOf(MergeSourceError);
    expect((img as MergeSourceError).sourceIndex).toBe(0);
  });

  it('leaves append input untouched after a failure and names encryption', async () => {
    const add = await makePdf(['new']);
    const enc = await makeEncryptedLookingPdf();
    const copy = Uint8Array.from(enc);
    const err = await mergePages([pdfSrc(add)], enc).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppendTargetError);
    expect((err as Error).message).toMatch(/encrypted/);
    expect(enc).toEqual(copy);
    const junk = new TextEncoder().encode('not a pdf');
    const e2 = await mergePages([pdfSrc(add)], junk).catch((e: unknown) => e);
    expect((e2 as Error).message).not.toMatch(/encrypted/);
  });
});
