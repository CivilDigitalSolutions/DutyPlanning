// Shared helpers: dates, DOM, toasts, dialogs.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

/** Tagged template that escapes interpolations unless wrapped with raw(). */
export function html(strings, ...values) {
  let out = '';
  strings.forEach((s, i) => {
    out += s;
    if (i < values.length) {
      const v = values[i];
      if (v && v.__raw) out += v.s;
      else if (Array.isArray(v)) out += v.map((x) => (x && x.__raw ? x.s : esc(x))).join('');
      else out += esc(v);
    }
  });
  return raw(out);
}
export const raw = (s) => ({ __raw: true, s: String(s), toString: () => String(s) });

// ---- Dates (ISO YYYY-MM-DD, UTC based) ----
export const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
export const parseIso = (s) => new Date(s + 'T00:00:00Z');
export const toIso = (d) => d.toISOString().slice(0, 10);
export const addDays = (iso, n) => {
  const d = parseIso(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return toIso(d);
};
export const daysBetween = (a, b) => Math.round((parseIso(b) - parseIso(a)) / 864e5);
export const eachDate = (from, to) => {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
};
export const weekday = (iso) => parseIso(iso).getUTCDay();
export const isWeekend = (iso) => [0, 6].includes(weekday(iso));
/** Monday of the week containing iso. */
export const startOfWeek = (iso) => addDays(iso, -((weekday(iso) + 6) % 7));
const fmt = (opts) => new Intl.DateTimeFormat(undefined, { timeZone: 'UTC', ...opts });
const F = {
  dow: fmt({ weekday: 'short' }),
  dowLong: fmt({ weekday: 'long' }),
  dm: fmt({ day: 'numeric', month: 'short' }),
  dmy: fmt({ day: 'numeric', month: 'short', year: 'numeric' }),
  long: fmt({ weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }),
  my: fmt({ month: 'long', year: 'numeric' }),
};
export const fmtDate = (iso, kind = 'dmy') => F[kind].format(parseIso(iso));
export const dayNum = (iso) => parseIso(iso).getUTCDate();

// ---- UI feedback ----
export function toast(message, kind = 'info', ms = 3500) {
  let host = $('#toasts');
  if (!host) {
    host = document.createElement('div');
    host.id = 'toasts';
    host.setAttribute('role', 'status');
    host.setAttribute('aria-live', 'polite');
    document.body.append(host);
  }
  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  el.textContent = message;
  host.append(el);
  setTimeout(() => el.classList.add('hide'), ms);
  setTimeout(() => el.remove(), ms + 400);
}

/**
 * Open a modal dialog. `body` is an html() result; returns the <dialog> element.
 * Resolves `closed` promise with dialog.returnValue.
 */
export function dialog(title, body, { wide = false, actions = '' } = {}) {
  const d = document.createElement('dialog');
  d.className = wide ? 'wide' : '';
  d.innerHTML = `<form method="dialog" class="dlg">
    <header><h2>${esc(title)}</h2><button class="icon-btn" value="cancel" aria-label="Close" formnovalidate>✕</button></header>
    <div class="dlg-body">${body}</div>
    ${actions ? `<footer>${actions}</footer>` : ''}
  </form>`;
  document.body.append(d);
  d.closed = new Promise((res) => d.addEventListener('close', () => {
    res(d.returnValue);
    setTimeout(() => d.remove(), 0);
  }));
  d.showModal();
  return d;
}

export function confirmDialog(message, okLabel = 'OK', danger = false) {
  const d = dialog('Please confirm', html`<p>${message}</p>`, {
    actions: `<button value="cancel" class="btn" formnovalidate>Cancel</button><button value="ok" class="btn ${danger ? 'btn-danger' : 'btn-primary'}">${esc(okLabel)}</button>`,
  });
  return d.closed.then((v) => v === 'ok');
}

/** Readable text colour (black/white) for a background hex colour. */
export function contrast(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return '#111';
  const n = parseInt(m[1], 16);
  const [r, g, b] = [n >> 16, (n >> 8) & 255, n & 255].map((v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? '#111' : '#fff';
}

export const debounce = (fn, ms = 200) => {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
};

export const store = {
  get(k, def) {
    try {
      const v = localStorage.getItem('dp.' + k);
      return v == null ? def : JSON.parse(v);
    } catch {
      return def;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem('dp.' + k, JSON.stringify(v));
    } catch {
      /* storage unavailable */
    }
  },
};
