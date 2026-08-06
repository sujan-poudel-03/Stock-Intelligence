// Best-effort resolver from user_id -> auth email, for per-user alert delivery (TIER-2).
//
// Emails live in Supabase Auth (auth.users), not in our app tables — reachable only via
// the Admin API, which REQUIRES the service-role client. So the caller passes its
// service supabase; a non-service client simply has no `auth.admin` and yields an empty
// map. PAGINATES listUsers() until a short page so users beyond page 1 aren't dropped.
//
// NEVER throws: on any failure it returns whatever it has (possibly empty), and the
// delivery path then just skips users it couldn't resolve — a side-channel must never
// break the scan/outcome flow. Emails are used only to send; they are never logged or
// returned to clients (the delivery path logs user_id, not email).

const PAGE_SIZE = 1000;
const MAX_PAGES = 50; // hard ceiling so a misbehaving API can never loop forever

export async function listUserEmailMap(svc) {
  const map = new Map();
  try {
    if (!svc?.auth?.admin?.listUsers) return map;
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const { data, error } = await svc.auth.admin.listUsers({ page, perPage: PAGE_SIZE });
      if (error) break;
      const users = data?.users || [];
      for (const u of users) {
        if (u?.id && u?.email) map.set(u.id, u.email);
      }
      if (users.length < PAGE_SIZE) break; // short page => last page reached
    }
  } catch {
    /* best-effort: never throw into the delivery/scan flow */
  }
  return map;
}
