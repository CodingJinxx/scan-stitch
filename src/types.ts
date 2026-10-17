export type Rotation = 0 | 90 | 180 | 270;
export type PageKind = 'pdf' | 'image';
export interface PageRef { id: string; path: string; pageIndex: number; kind: PageKind; rotation: Rotation; seenAt: number; }
export interface SessionData {
  id: string; startedAt: number; watchRoot: string; destinationFolder: string;
  templateName: string; filename: string; appendTarget: string | null;
  pages: PageRef[]; discardedPaths: string[]; phase: 'scanning' | 'review';
}
export interface Template { name: string; pattern: string; folder?: string; }
export interface ScanStitchSettings {
  watchRoot: string; includeSubfolders: boolean; patterns: string[];
  stabilityDelayMs: number; stabilityRetries: number;
  templates: Template[]; defaultTemplate: string; recentLocations: string[];
  session: SessionData | null;
}
