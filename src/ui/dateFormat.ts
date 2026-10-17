import { moment } from 'obsidian';

// Obsidian ships moment at runtime, but its type comes from the separate `moment`
// package. Where that package's types do not resolve, `moment` is `any` and every
// call is an unsafe-* lint finding. This local shape keeps the calls typed either way.
interface MomentLike {
  format(format: string): string;
}
type MomentFactory = (input?: Date) => MomentLike;
const create = moment as unknown as MomentFactory;

/** Formats `date` with a moment.js format string (e.g. `YYYY-MM-DD`). */
export function formatDate(date: Date, format: string): string {
  return create(date).format(format);
}

/** Formats the current time with a moment.js format string. */
export function nowStamp(format: string): string {
  return create().format(format);
}
