// iCalendar file of someone's duties (rest days left out).
import { addDays } from './dates.js';

/** rows: [{ date, code, note }], info: (code) => { label, category } */
export function buildIcs({ orgName, personId, rows, info }) {
  const esc = (t) => String(t).replace(/[\\;,]/g, (m) => '\\' + m).replace(/\n/g, '\\n');
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//DutyPlanning//EN', 'CALSCALE:GREGORIAN', `X-WR-CALNAME:${esc(orgName)} duties`];
  for (const r of rows) {
    const c = info(r.code);
    if (c?.category === 'rest') continue;
    const d = r.date.replace(/-/g, '');
    lines.push(
      'BEGIN:VEVENT',
      `UID:${personId}-${d}@dutyplanning`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${d}`,
      `DTEND;VALUE=DATE:${addDays(r.date, 1).replace(/-/g, '')}`,
      `SUMMARY:${esc(c && c.label !== r.code ? `${r.code} - ${c.label}` : r.code)}`,
      ...(r.note ? [`DESCRIPTION:${esc(r.note)}`] : []),
      'TRANSP:TRANSPARENT',
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}
