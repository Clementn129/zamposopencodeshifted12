import { format } from 'date-fns';

// Local calendar date as YYYY-MM-DD. `expense_date`, `expiry_date` and the POS
// backdating defaults are plain dates picked in the browser's timezone, so
// "today" must be the LOCAL date — `new Date().toISOString()...` is UTC and
// drifts a day inside Zambia's UTC+2 window.
export const todayLocal = (date: Date = new Date()): string =>
  format(date, 'yyyy-MM-dd');

// Date part of a local Date as YYYY-MM-DD, for filtering date-string columns.
export const dateString = (date: Date): string => format(date, 'yyyy-MM-dd');

// Parse a YYYY-MM-DD string as LOCAL midnight (new Date('YYYY-MM-DD') parses
// as UTC midnight, shifting the day for any non-UTC offset).
export const parseDateString = (dateStr: string | null | undefined): Date =>
  new Date(`${dateStr}T00:00:00`);

// Convert a local calendar day into the UTC instants for start/end so a
// timestamptz column (created_at) matches the user's "today".
export type DayBounds = { from: string; to: string };

export const localDayBounds = (date: Date = new Date()): DayBounds => {
  const from = new Date(date);
  from.setHours(0, 0, 0, 0);
  const to = new Date(date);
  to.setHours(23, 59, 59, 999);
  return { from: from.toISOString(), to: to.toISOString() };
};