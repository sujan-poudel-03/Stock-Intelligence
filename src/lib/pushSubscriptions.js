// Browser push subscription storage — the capture half of Web Push (Phase G
// reach; see supabase/migrations/20260919000000_push_subscriptions.sql for why
// actually SENDING an encrypted push is a separate, deferred step). Mirrors the
// owner-scoped-client pattern used by telegramLink.js.

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
