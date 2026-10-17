import { describe, expect, it } from 'vitest';
import {
  EXISTING_SESSION_OPTIONS,
  confirmText,
  keptBackupNotice,
  resumeChoice,
  sessionSummary,
} from '../../src/ui/lifecycleLogic';
import type { SessionData } from '../../src/types';

function data(over: Partial<SessionData> = {}): SessionData {
  return {
    id: 'a',
    startedAt: 1000,
    watchRoot: '/scans',
    destinationFolder: 'Inbox/Scans',
    templateName: 'T',
    filename: 'out',
    appendTarget: null,
    pages: [],
    discardedPaths: [],
    phase: 'scanning',
    ...over,
  };
}

describe('resumeChoice', () => {
  it('is none without a stored session', () => {
    expect(resumeChoice(null)).toBe('none');
  });
  it('maps phase to the pane to open', () => {
    expect(resumeChoice(data({ phase: 'scanning' }))).toBe('scanning');
    expect(resumeChoice(data({ phase: 'review' }))).toBe('review');
  });
  it('treats a malformed object as scanning-safe none', () => {
    expect(resumeChoice({} as unknown as SessionData)).toBe('scanning');
    expect(resumeChoice('x' as unknown as SessionData)).toBe('none');
  });
});

describe('sessionSummary', () => {
  it('lists page count, destination and start time', () => {
    const s = data({
      pages: [
        { id: '1', path: 'a', pageIndex: 0, kind: 'pdf', rotation: 0, seenAt: 1 },
        { id: '2', path: 'a', pageIndex: 1, kind: 'pdf', rotation: 0, seenAt: 1 },
      ],
    });
    expect(sessionSummary(s, (t) => `T${t}`)).toEqual([
      { label: 'Pages', value: '2' },
      { label: 'Destination', value: 'Inbox/Scans' },
      { label: 'Started', value: 'T1000' },
    ]);
  });
  it('singular page, empty destination and bad fields do not throw', () => {
    const one = data({ pages: [{ id: '1', path: 'a', pageIndex: 0, kind: 'pdf', rotation: 0, seenAt: 1 }], destinationFolder: '' });
    const r = sessionSummary(one, () => 'when');
    expect(r[0].value).toBe('1');
    expect(r[1].value).toBe('(vault root)');
    expect(() => sessionSummary({} as unknown as SessionData, () => 'x')).not.toThrow();
  });
});

describe('existing session options', () => {
  it('only replace is destructive and needs confirm', () => {
    expect(EXISTING_SESSION_OPTIONS.map((o) => o.id)).toEqual(['resume', 'replace', 'cancel']);
    expect(EXISTING_SESSION_OPTIONS.filter((o) => o.destructive).map((o) => o.id)).toEqual(['replace']);
    expect(confirmText('replace')).toBe('This drops the pages scanned so far');
    expect(confirmText('resume')).toBeNull();
  });
  it('drop confirm text', () => {
    expect(confirmText('drop')).toBe('Drop this scan session? Scanned pages stay in the scanner folder.');
  });
});

describe('keptBackupNotice', () => {
  const dir = 'config/plugins/scan-stitch/backups';
  it('is null without a backups folder or when it is empty', () => {
    expect(keptBackupNotice(dir, null)).toBeNull();
    expect(keptBackupNotice(dir, { files: [], folders: [] })).toBeNull();
  });
  it('names the folder once when backups were kept', () => {
    const msg = keptBackupNotice(dir, { files: [`${dir}/20261017-101500-X.pdf`, `${dir}/20261017-101600-Y.pdf`], folders: [] });
    expect(msg).toBe(
      'Scan Stitch kept a backup of a PDF it was changing (config/plugins/scan-stitch/backups). If the PDF looks wrong, copy the backup back.',
    );
  });
  it('ignores empty subfolders', () => {
    expect(keptBackupNotice(dir, { files: [], folders: [`${dir}/tmp`] })).toBeNull();
  });
});
