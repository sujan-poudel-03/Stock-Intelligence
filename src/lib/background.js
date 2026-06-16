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
// Pass `origin` (e.g. request.nextUrl.origin) so the self-call targets the port
// the server actually bound to — `next dev` bumps to 3001+ when 3000 is taken.
export function triggerRoute(path, { method = 'POST', body, headers, origin } = {}) {
  const url = `${getBaseUrl(origin)}${path}`;
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

// Resolve the app's own base URL for self-calls. An explicit `origin` from the
// incoming request wins so local chaining works on whatever port the dev server
// bound to; env overrides come next, then the localhost default.
export function getBaseUrl(origin) {
  if (process.env.APP_BASE_URL) return process.env.APP_BASE_URL;
  if (origin) return origin;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return 'http://localhost:3000';
}
