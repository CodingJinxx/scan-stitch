import type { PageRef } from '../types';

export interface PageImage {
  url: string;
  width: number;
  height: number;
}

export interface RenderEnv {
  createCanvas(w: number, h: number): { canvas: unknown; ctx: unknown; toBlob(): Promise<Blob> };
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
}

export type DecodeImage = (blob: Blob) => Promise<{ width: number; height: number }>;

const CACHE_SIZE = 60;

// Defaults only touch document/URL when called, never at import time.
const defaultEnv: RenderEnv = {
  createCanvas(w, h) {
    const canvas = createEl('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    return {
      canvas,
      ctx,
      toBlob: () =>
        new Promise<Blob>((resolve, reject) => {
          canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Canvas encode failed'))), 'image/png');
        }),
    };
  },
  createObjectURL: (blob) => URL.createObjectURL(blob),
  revokeObjectURL: (url) => URL.revokeObjectURL(url),
};

const defaultDecodeImage: DecodeImage = async (blob) => {
  if (typeof createImageBitmap === 'function') {
    const bmp = await createImageBitmap(blob);
    const size = { width: bmp.width, height: bmp.height };
    bmp.close();
    return size;
  }
  const url = URL.createObjectURL(blob);
  try {
    return await new Promise<{ width: number; height: number }>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
      img.onerror = () => reject(new Error('Image decode failed'));
      img.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
};

function mimeFor(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return ext === 'png' ? 'image/png' : 'image/jpeg';
}

interface PdfViewport {
  width: number;
  height: number;
}
interface PdfPage {
  getViewport(args: { scale: number }): PdfViewport;
  render(args: { canvasContext: unknown; viewport: PdfViewport }): { promise: Promise<unknown> };
}
interface PdfDoc {
  getPage(n: number): Promise<PdfPage>;
  destroy?: () => unknown;
}
interface PdfJs {
  getDocument(args: { data: Uint8Array }): { promise: Promise<PdfDoc> };
}

export class PageRenderer {
  private cache = new Map<string, PageImage>();
  private inflight = new Map<string, Promise<PageImage>>();
  private docs = new Map<string, Promise<PdfDoc>>();
  private openDocs = new Set<PdfDoc>();
  private disposed = false;

  constructor(
    private readonly loadBytes: (path: string) => Promise<Uint8Array>,
    private readonly loadPdfJs: () => Promise<PdfJs>,
    private readonly env: RenderEnv = defaultEnv,
    private readonly decodeImage: DecodeImage = defaultDecodeImage,
  ) {}

  render(page: PageRef, maxEdge: number): Promise<PageImage> {
    if (this.disposed) return Promise.reject(new Error('PageRenderer disposed'));
    const key = `${page.id}@${maxEdge}`;
    const hit = this.cache.get(key);
    if (hit) {
      this.cache.delete(key);
      this.cache.set(key, hit);
      return Promise.resolve(hit);
    }
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const p = this.doRender(page, maxEdge).then(
      (img) => {
        this.inflight.delete(key);
        if (this.disposed) {
          this.env.revokeObjectURL(img.url);
          throw new Error('PageRenderer disposed');
        }
        this.cache.set(key, img);
        while (this.cache.size > CACHE_SIZE) {
          const oldest = this.cache.keys().next().value as string;
          const old = this.cache.get(oldest)!;
          this.cache.delete(oldest);
          this.env.revokeObjectURL(old.url);
        }
        return img;
      },
      (err: unknown) => {
        this.inflight.delete(key);
        throw err;
      },
    );
    this.inflight.set(key, p);
    return p;
  }

  dispose(): void {
    this.disposed = true;
    for (const img of this.cache.values()) this.env.revokeObjectURL(img.url);
    this.cache.clear();
    this.inflight.clear();
    for (const doc of this.openDocs) void doc.destroy?.();
    this.openDocs.clear();
    for (const d of this.docs.values()) {
      d.then(
        (doc) => {
          if (!this.openDocs.has(doc)) void doc.destroy?.();
        },
        () => undefined,
      );
    }
    this.docs.clear();
  }

  private async doRender(page: PageRef, maxEdge: number): Promise<PageImage> {
    return page.kind === 'image' ? this.renderImage(page, maxEdge) : this.renderPdf(page, maxEdge);
  }

  private async renderImage(page: PageRef, maxEdge: number): Promise<PageImage> {
    const bytes = await this.loadBytes(page.path);
    const blob = new Blob([bytes], { type: mimeFor(page.path) });
    const size = await this.decodeImage(blob);
    const scale = Math.min(1, maxEdge / Math.max(size.width, size.height));
    return {
      url: this.env.createObjectURL(blob),
      width: Math.max(1, Math.round(size.width * scale)),
      height: Math.max(1, Math.round(size.height * scale)),
    };
  }

  private getDoc(path: string): Promise<PdfDoc> {
    let d = this.docs.get(path);
    if (!d) {
      d = (async () => {
        const [bytes, pdfjs] = await Promise.all([this.loadBytes(path), this.loadPdfJs()]);
        const doc = await pdfjs.getDocument({ data: bytes }).promise;
        if (!this.disposed) this.openDocs.add(doc);
        return doc;
      })();
      this.docs.set(path, d);
      d.catch(() => {
        if (this.docs.get(path) === d) this.docs.delete(path);
      });
    }
    return d;
  }

  private async renderPdf(page: PageRef, maxEdge: number): Promise<PageImage> {
    const doc = await this.getDoc(page.path);
    const pdfPage = await doc.getPage(page.pageIndex + 1);
    const base = pdfPage.getViewport({ scale: 1 });
    const scale = maxEdge / Math.max(base.width, base.height);
    const viewport = pdfPage.getViewport({ scale });
    const width = Math.max(1, Math.round(viewport.width));
    const height = Math.max(1, Math.round(viewport.height));
    const surface = this.env.createCanvas(width, height);
    await pdfPage.render({ canvasContext: surface.ctx, viewport }).promise;
    const blob = await surface.toBlob();
    return { url: this.env.createObjectURL(blob), width, height };
  }
}
