// Thin fetch wrapper. GET responses may come from the service worker cache
// when offline; the SW marks those with an X-From-Cache header.

export class ApiError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const listeners = new Set();
export const onApiEvent = (fn) => listeners.add(fn);
const emit = (e) => listeners.forEach((fn) => fn(e));

export async function api(path, { method = 'GET', body, headers = {}, raw = false } = {}) {
  const opts = { method, headers: { ...headers }, credentials: 'same-origin' };
  if (method !== 'GET') opts.headers['X-Requested-With'] = 'DutyPlanning';
  if (body !== undefined) {
    if (body instanceof Blob || body instanceof ArrayBuffer) opts.body = body;
    else {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
  }
  let res;
  try {
    res = await fetch('/api' + path, opts);
  } catch {
    emit({ type: 'offline' });
    throw new ApiError(0, method === 'GET' ? 'You are offline and this data has not been saved on this device yet' : 'You are offline - changes cannot be saved right now');
  }
  if (res.headers.get('X-From-Cache')) emit({ type: 'stale', at: res.headers.get('X-Cached-At') });
  else emit({ type: 'online' });
  if (raw && res.ok) return res;
  const data = res.headers.get('Content-Type')?.includes('json') ? await res.json() : null;
  if (!res.ok) {
    if (res.status === 401) emit({ type: 'unauthorized' });
    if (data?.code === 'PASSWORD_CHANGE') emit({ type: 'password-change' });
    throw new ApiError(res.status, data?.error || `Request failed (${res.status})`, data?.code);
  }
  return data;
}

export const get = (p) => api(p);
export const post = (p, body) => api(p, { method: 'POST', body: body ?? {} });
export const put = (p, body) => api(p, { method: 'PUT', body });
export const del = (p) => api(p, { method: 'DELETE' });
