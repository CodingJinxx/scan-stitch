import type { PageRef } from '../types';

export interface PageImage {
  url: string;
  width: number;
  height: number;
}

export interface RenderEnv {
  createCanvas(w: number, h: number): { canvas: unknown; ctx: unknown; toBlob(): Promise<Blob> };
  releaseCanvas?(surface: { canvas: unknown; ctx: unknown }): void;
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
}

export type DecodeImage = (blob: Blob) => Promise<{ width: number; height: number }>;

const CACHE_SIZE = 60;
const MAX_OPEN_DOCS = 6;
const MAX_PIXELS = 16_000_000;
const MAX_SCALE = 4;

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
  releaseCanvas(surface) {
    const c = surface.canvas as HTMLCanvasElement;
    c.width = 0;
    c.height = 0;
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
  cleanup?: () => unknown;
}
interface PdfDoc {
  getPage(n: number): Promise<PdfPage>;
  destroy?: () => unknown;
}
interface DocEntry {
  promise: Promise<PdfDoc>;
  doc?: PdfDoc;
  busy: number;
}
interface PdfJs {
  getDocument(args: { data: Uint8Array }): { promise: Promise<PdfDoc> };
}

export class PageRenderer {
  private cache = new Map<string, PageImage>();
  private inflight = new Map<string, Promise<PageImage>>();
  private docs = new Map<string, DocEntry>();
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
    for (const entry of this.docs.values()) {
      if (entry.doc) void entry.doc.destroy?.();
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

  private getEntry(path: string): DocEntry {
    const existing = this.docs.get(path);
    if (existing) {
      this.docs.delete(path);
      this.docs.set(path, existing);
      return existing;
    }
    const e: DocEntry = { busy: 0, promise: undefined as unknown as Promise<PdfDoc> };
    e.promise = (async () => {
      try {
        const [bytes, pdfjs] = await Promise.all([this.loadBytes(path), this.loadPdfJs()]);
        const doc = await pdfjs.getDocument({ data: bytes }).promise;
        if (this.disposed) {
          void doc.destroy?.();
          throw new Error('PageRenderer disposed');
        }
        e.doc = doc;
        return doc;
      } catch (err) {
        if (this.docs.get(path) === e) this.docs.delete(path);
        throw err;
      }
    })();
    this.docs.set(path, e);
    return e;
  }

  private evictDocs(): void {
    for (;;) {
      let open = 0;
      let victim: string | undefined;
      for (const [path, e] of this.docs) {
        if (!e.doc) continue;
        open++;
        if (victim === undefined && e.busy === 0) victim = path;
      }
      if (open <= MAX_OPEN_DOCS || victim === undefined) return;
      const e = this.docs.get(victim)!;
      this.docs.delete(victim);
      void e.doc?.destroy?.();
    }
  }

  private async renderPdf(page: PageRef, maxEdge: number): Promise<PageImage> {
    const entry = this.getEntry(page.path);
    entry.busy++;
    try {
      const doc = await entry.promise;
      this.evictDocs();
      const pdfPage = await doc.getPage(page.pageIndex + 1);
      try {
        const base = pdfPage.getViewport({ scale: 1 });
        const scale = Math.min(
          MAX_SCALE,
          maxEdge / Math.max(base.width, base.height),
          Math.sqrt(MAX_PIXELS / (base.width * base.height)),
        );
        const viewport = pdfPage.getViewport({ scale });
        const width = Math.max(1, Math.round(viewport.width));
        const height = Math.max(1, Math.round(viewport.height));
        const surface = this.env.createCanvas(width, height);
        try {
          await pdfPage.render({ canvasContext: surface.ctx, viewport }).promise;
          const blob = await surface.toBlob();
          return { url: this.env.createObjectURL(blob), width, height };
        } finally {
          this.env.releaseCanvas?.(surface);
        }
      } finally {
        pdfPage.cleanup?.();
      }
    } finally {
      entry.busy--;
      this.evictDocs();
    }
  }
}
