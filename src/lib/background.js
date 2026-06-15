import { waitUntil } from '@vercel/functions';

// On Vercel, schedule background work with waitUntil so the response can return
// immediately while processing continues (within the 60s function budget).
// Locally (no VERCEL env), await the work so dev flows run synchronously.
export async function runBackground(work) {
  const promise = Promise.resolve().then(work);

  if (process.env.VERCEL) {
    waitUntil(promise);
    return;
  }

  await promise;
}

// Fire-and-forget internal fetch used to chain route handlers
// (e.g. cron -> worker -> brief). Never throws into the caller.
export function triggerRoute(path, { method = 'POST', body, headers } = {}) {
  const url = `${getBaseUrl()}${path}`;
  const promise = fetch(url, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  }).catch((err) => {
    console.error(`triggerRoute ${path} failed:`, err?.message || err);
  });

  if (process.env.VERCEL) {
    waitUntil(promise);
  }
  return promise;
}

// Resolve the app's own base URL for self-calls.
export function getBaseUrl() {
  if (process.env.APP_BASE_URL) return process.env.APP_BASE_URL;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return 'http://localhost:3000';
}
