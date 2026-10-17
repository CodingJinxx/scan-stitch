import type { ScanStitchSettings } from '../types';

export const DEFAULT_SETTINGS: ScanStitchSettings = {
  watchRoot: '',
  includeSubfolders: true,
  patterns: ['*.pdf'],
  stabilityDelayMs: 1000,
  stabilityRetries: 3,
  templates: [{ name: 'Scan', pattern: 'Scan {date} {time}' }],
  defaultTemplate: 'Scan',
  recentLocations: [],
  session: null,
};
