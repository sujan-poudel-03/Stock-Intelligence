'use client';

// Client-side key/value storage that mirrors V1's window.storage interface,
// backed by the /api/storage route (kv_store table).
//
//   dbGet(key)        -> value (jsonb) | null
//   dbSet(key, value) -> value
//   dbRemove(key)     -> true
//
// Keys follow the V1 convention, e.g. "ni:wl" (watchlist), "ni:brief".

export async function dbGet(key) {
  try {
    const res = await fetch(`/api/storage?key=${encodeURIComponent(key)}`, {
      method: 'GET',
    });
    if (!res.ok) return null;
    const json = await res.json();
    return json?.value ?? null;
  } catch (err) {
    console.error(`dbGet(${key}) failed:`, err);
    return null;
  }
}

export async function dbSet(key, value) {
  const res = await fetch('/api/storage', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key, value }),
  });
  if (!res.ok) throw new Error(`dbSet(${key}) failed: ${res.status}`);
  return value;
}

export async function dbRemove(key) {
  const res = await fetch(`/api/storage?key=${encodeURIComponent(key)}`, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error(`dbRemove(${key}) failed: ${res.status}`);
  return true;
}
