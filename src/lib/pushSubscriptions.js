// Browser push subscription storage (Phase G reach). Mirrors the owner-scoped-
// client pattern used by telegramLink.js. Actual encrypted SENDING lives in
// notify.js's deliverPush (RFC 8291, via the `web-push` package) — this file is
// just the subscription ledger it reads from and prunes.

import { pushSubscriptionsReady } from './schemaFlags.js';

// saveSubscription(supabase, userId, subscription): upsert one browser's
// PushSubscription ({ endpoint, keys: { p256dh, auth } }, exactly the shape
// PushManager.subscribe() resolves to). Returns true on success, false on any
// miss (unmigrated DB, malformed subscription, write error) — never throws.
export async function saveSubscription(supabase, userId, subscription) {
  try {
    if (!supabase || !userId) return false;
    const endpoint = subscription?.endpoint;
    const p256dh = subscription?.keys?.p256dh;
    const authKey = subscription?.keys?.auth;
    if (!endpoint || !p256dh || !authKey) return false;
    if (!(await pushSubscriptionsReady())) return false;
    const { error } = await supabase
      .from('push_subscriptions')
      .upsert({ user_id: userId, endpoint, p256dh, auth_key: authKey }, { onConflict: 'endpoint' });
    return !error;
  } catch {
    return false;
  }
}

// removeSubscription(supabase, userId, endpoint): drop one of this user's
// subscriptions (e.g. the browser revoked permission or unsubscribed itself).
export async function removeSubscription(supabase, userId, endpoint) {
  try {
    if (!supabase || !userId || !endpoint) return false;
    if (!(await pushSubscriptionsReady())) return false;
    const { error } = await supabase.from('push_subscriptions').delete().eq('user_id', userId).eq('endpoint', endpoint);
    return !error;
  } catch {
    return false;
  }
}

// hasAnySubscription(supabase, userId): whether this user has at least one
// stored subscription — drives the Settings UI's "connected" state.
export async function hasAnySubscription(supabase, userId) {
  try {
    if (!supabase || !userId) return false;
    if (!(await pushSubscriptionsReady())) return false;
    const { count } = await supabase
      .from('push_subscriptions')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId);
    return !!count;
  } catch {
    return false;
  }
}

// listSubscriptionsByUser(supabase, userIds) -> Map<user_id, [{endpoint,p256dh,auth_key}]>
// One batched read for the per-user push fan-out in alertDelivery.js — same
// "fetch once, loop over the map" shape as listUserEmailMap, not one query per
// user. Empty map on any miss (unmigrated DB, empty input, read failure).
export async function listSubscriptionsByUser(supabase, userIds) {
  try {
    if (!supabase || !Array.isArray(userIds) || !userIds.length) return new Map();
    if (!(await pushSubscriptionsReady())) return new Map();
    const { data, error } = await supabase
      .from('push_subscriptions')
      .select('user_id, endpoint, p256dh, auth_key')
      .in('user_id', userIds);
    if (error || !Array.isArray(data)) return new Map();
    const map = new Map();
    for (const row of data) {
      if (!row?.user_id || !row?.endpoint) continue;
      if (!map.has(row.user_id)) map.set(row.user_id, []);
      map.get(row.user_id).push({ endpoint: row.endpoint, p256dh: row.p256dh, auth_key: row.auth_key });
    }
    return map;
  } catch {
    return new Map();
  }
}
