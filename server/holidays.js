// UK bank holidays, calculated from the standard rules (including substitute days
// when a holiday falls at a weekend). One-off holidays (e.g. a coronation) and
// rare moved dates are not included - add those by hand in the app.

const iso = (y, m, d) => new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);
const dow = (s) => new Date(s + 'T00:00:00Z').getUTCDay();
const plus = (s, n) => {
  const d = new Date(s + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** Western Easter Sunday (anonymous Gregorian algorithm). */
export function easterSunday(y) {
  const a = y % 19;
  const b = Math.floor(y / 100);
  const c = y % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return iso(y, month, day);
}
const firstMonday = (y, m) => {
  let s = iso(y, m, 1);
  while (dow(s) !== 1) s = plus(s, 1);
  return s;
};
const lastMonday = (y, m) => {
  let s = plus(iso(y, m + 1, 1), -1);
  while (dow(s) !== 1) s = plus(s, -1);
  return s;
};

export const REGIONS = {
  'england-wales': 'England and Wales',
  scotland: 'Scotland',
  'northern-ireland': 'Northern Ireland',
};

/** @returns [{ date, name }] for the year and region, in date order. */
export function ukBankHolidays(year, region = 'england-wales') {
  const easter = easterSunday(year);
  // Fixed-date holidays move to the next free weekday if they fall at a weekend.
  const fixed = [['New Year’s Day', iso(year, 1, 1)]];
  if (region === 'scotland') fixed.push(['2nd January', iso(year, 1, 2)]);
  if (region === 'northern-ireland') fixed.push(['St Patrick’s Day', iso(year, 3, 17)]);
  if (region === 'northern-ireland') fixed.push(['Battle of the Boyne (Orangemen’s Day)', iso(year, 7, 12)]);
  if (region === 'scotland') fixed.push(['St Andrew’s Day', iso(year, 11, 30)]);
  fixed.push(['Christmas Day', iso(year, 12, 25)], ['Boxing Day', iso(year, 12, 26)]);

  const out = [
    { name: 'Good Friday', date: plus(easter, -2) },
    ...(region === 'scotland' ? [] : [{ name: 'Easter Monday', date: plus(easter, 1) }]),
    { name: 'Early May bank holiday', date: firstMonday(year, 5) },
    { name: 'Spring bank holiday', date: lastMonday(year, 5) },
    { name: 'Summer bank holiday', date: region === 'scotland' ? firstMonday(year, 8) : lastMonday(year, 8) },
  ];
  const taken = new Set(out.map((h) => h.date));
  // Weekday holidays keep their date; weekend ones then move to the next free weekday.
  const weekend = [];
  for (const [name, date] of fixed) {
    if ([0, 6].includes(dow(date)) || taken.has(date)) weekend.push([name, date]);
    else {
      taken.add(date);
      out.push({ name, date });
    }
  }
  for (const [name, date] of weekend) {
    let d = date;
    while ([0, 6].includes(dow(d)) || taken.has(d)) d = plus(d, 1);
    taken.add(d);
    out.push({ name: `${name} (substitute day)`, date: d });
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : 1));
}
