import type { SessionData } from '../types';

export type ResumeChoice = 'none' | 'scanning' | 'review';

/** Which pane a stored session reopens in; 'none' when there is nothing usable to resume. */
export function resumeChoice(session: SessionData | null): ResumeChoice {
  if (typeof session !== 'object' || session === null) return 'none';
  return session.phase === 'review' ? 'review' : 'scanning';
}

export interface SummaryLine {
  label: string;
  value: string;
}

/** What the resume prompt shows about the stored session. Tolerates malformed data. */
export function sessionSummary(session: SessionData, formatTime: (ms: number) => string): SummaryLine[] {
  const pages = Array.isArray(session.pages) ? session.pages.length : 0;
  const dest = typeof session.destinationFolder === 'string' && session.destinationFolder !== '' ? session.destinationFolder : '(vault root)';
  const started = typeof session.startedAt === 'number' && Number.isFinite(session.startedAt) ? formatTime(session.startedAt) : 'unknown';
  return [
    { label: 'Pages', value: String(pages) },
    { label: 'Destination', value: dest },
    { label: 'Started', value: started },
  ];
}

export type ExistingSessionChoice = 'resume' | 'replace' | 'cancel';

export interface ExistingSessionOption {
  id: ExistingSessionChoice;
  label: string;
  destructive: boolean;
}

export const EXISTING_SESSION_OPTIONS: readonly ExistingSessionOption[] = [
  { id: 'resume', label: 'Resume current session', destructive: false },
  { id: 'replace', label: 'Replace it', destructive: true },
  { id: 'cancel', label: 'Cancel', destructive: false },
];

/** Confirmation question for actions that discard a session, null when none is needed. */
export function confirmText(action: ExistingSessionChoice | 'drop' | 'resume'): string | null {
  if (action === 'replace') return 'This drops the pages scanned so far';
  if (action === 'drop') return 'Drop this scan session? Scanned pages stay in the scanner folder.';
  return null;
}
