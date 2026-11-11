// Dates are handled as ISO "YYYY-MM-DD" strings in UTC to avoid timezone drift.
export const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

export function isValidIso(s) {
  if (typeof s !== 'string' || !ISO_RE.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d) && isoDate(d) === s;
}

export function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return isoDate(d);
}

export function daysBetween(a, b) {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 864e5);
}

export function eachDate(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}
