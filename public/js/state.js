// Application state shared between views.
import { get } from './api.js';

export const state = {
  user: null,
  meta: null,
  codeMap: new Map(), // lower-case code -> duty code object
  teamMap: new Map(),
  accMap: new Map(),
};

export const isPlanner = () => ['planner', 'admin'].includes(state.user?.role);
export const isAdmin = () => state.user?.role === 'admin';

export async function loadMeta() {
  const meta = await get('/meta');
  state.meta = meta;
  state.codeMap = new Map(meta.dutyCodes.map((c) => [c.code.toLowerCase(), c]));
  state.teamMap = new Map(meta.teams.map((t) => [t.id, t]));
  state.accMap = new Map(meta.accreditations.map((a) => [a.id, a]));
  return meta;
}

const MASKED = { code: '*', label: 'Unavailable', category: 'other', color: '#e5e7eb' };
export const codeInfo = (code) =>
  code === '*' ? MASKED : state.codeMap.get(String(code).toLowerCase()) || { code, label: code, category: 'other', color: '#e5e7eb' };

/** Fetch roster for a range and index assignments by person+date. */
export async function loadRoster(from, to, { person } = {}) {
  const data = await get(`/roster?from=${from}&to=${to}${person ? `&person=${person}` : ''}`);
  const cells = new Map();
  for (const [p, d, c, n] of data.assignments) cells.set(`${p}|${d}`, n ? { c, n } : { c });
  data.cells = cells;
  data.peopleById = new Map(data.people.map((p) => [p.id, p]));
  return data;
}

/** Accreditation status for a person record: 'ok' | 'expiring' | 'expired' | null */
export function accStatus(entry, today) {
  if (!entry) return null;
  if (!entry.e) return 'ok';
  if (entry.e < today) return 'expired';
  const soon = new Date(today + 'T00:00:00Z');
  soon.setUTCDate(soon.getUTCDate() + 60);
  return entry.e <= soon.toISOString().slice(0, 10) ? 'expiring' : 'ok';
}

/** Whether a code counts toward on-duty strength. */
export const onDuty = (code) => code !== '*' && codeInfo(code).category === 'duty';
