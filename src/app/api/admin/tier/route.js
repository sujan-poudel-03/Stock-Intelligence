import { NextResponse } from 'next/server';
import { withGuard } from '@/lib/respond';
import { requireAdmin } from '@/lib/auth';
import { getServiceSupabase } from '@/lib/supabase';
import { TIERS } from '@/lib/entitlements';

export const dynamic = 'force-dynamic';

// Admin tier control. ADMIN-ONLY (server-enforced against ADMIN_EMAILS via
// requireAdmin; open while single-operator). Tier writes go through the SERVICE
// client so RLS's service-WRITE policy applies — a user can NEVER set their own tier
// (their token only has owner-READ on subscriptions).

// GET /api/admin/tier -> all subscription rows (admin view). Emails are optional;
// user_id is the stable key.
export const GET = withGuard(async (request) => {
  const gate = await requireAdmin(request);
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });

  const svc = getServiceSupabase();
  const { data, error } = await svc
    .from('subscriptions')
    .select('user_id, tier, status, updated_at')
    .order('updated_at', { ascending: false });
  if (error) throw error;
  return NextResponse.json({ subscriptions: data || [] });
});

// POST /api/admin/tier { email? , user_id?, tier, status? } -> upsert a user's tier.
export const POST = withGuard(async (request) => {
  const gate = await requireAdmin(request);
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });

  const body = await request.json().catch(() => ({}));
  const tier = String(body?.tier || '').trim();
  if (!tier || !Object.prototype.hasOwnProperty.call(TIERS, tier)) {
    return NextResponse.json(
      { error: 'unknown tier', tiers: Object.keys(TIERS) },
      { status: 400 }
    );
  }

  const svc = getServiceSupabase();

  // Resolve the target user_id: explicit user_id wins; otherwise look up by email.
  let userId = body?.user_id ? String(body.user_id).trim() : '';
  if (!userId) {
    const email = String(body?.email || '').trim().toLowerCase();
    if (!email) {
      return NextResponse.json({ error: 'user_id or email required' }, { status: 400 });
    }
    try {
      const { data, error } = await svc.auth.admin.listUsers();
      if (error) throw error;
      const match = (data?.users || []).find(
        (u) => (u.email || '').trim().toLowerCase() === email
      );
      if (!match) return NextResponse.json({ error: 'user not found' }, { status: 404 });
      userId = match.id;
    } catch (err) {
      return NextResponse.json({ error: err?.message || 'user lookup failed' }, { status: 500 });
    }
  }

  const status = String(body?.status || 'active').trim();
  const { error } = await svc.from('subscriptions').upsert(
    { user_id: userId, tier, status, updated_at: new Date().toISOString() },
    { onConflict: 'user_id' }
  );
  if (error) throw error;

  return NextResponse.json({ ok: true, user_id: userId, tier });
});
