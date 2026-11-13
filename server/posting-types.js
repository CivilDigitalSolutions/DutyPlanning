// Posting types created in a new database (editable under Manage -> Posting types).
export const DEFAULT_POSTING_TYPES = [
  { name: 'Patrol', short: 'PAT', color: '#8ecae6' },
  { name: 'Response driver', short: 'DRV', color: '#f4a261' },
  { name: 'Appointments', short: 'APPT', color: '#a3d9a5' },
  { name: 'Enquiries', short: 'ENQ', color: '#ffd166' },
  { name: 'Paperwork', short: 'PAPR', color: '#cdb4db' },
  { name: 'Custody', short: 'CUST', color: '#f28482' },
  { name: 'Station duties', short: 'STN', color: '#d0d7de' },
];

/** Short code shown in plan cells: the type's own, or made from its name. */
export function shortCode(t) {
  if (t.short) return t.short;
  const words = String(t.name || '').trim().split(/\s+/);
  return (words.length > 1 ? words.map((w) => w[0]).join('') : words[0].slice(0, 4)).toUpperCase().slice(0, 4);
}
