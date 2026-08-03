import { NextResponse } from 'next/server';
import { withGuard, edgeCache } from '@/lib/respond';
import { EXCHANGES, DEFAULT_EXCHANGE } from '@/lib/exchanges';
import { validateSources } from '@/lib/marketProviders';

export const dynamic = 'force-dynamic';

// GET /api/exchanges -> the exchange registry + server-gated availability, so the
// client can offer only markets whose price sources are actually live. Availability
// is decided server-side (env flags like ENABLE_NYSE) and must NEVER be read from
// the browser. NEPSE always uses the admin-selected sources, so it is always
// available; any other exchange is available only when its configured sourceIds
// survive the same availability gate (implemented + required env present/truthy).
export const GET = withGuard(async () => {
  const exchanges = Object.values(EXCHANGES).map((ex) => {
    const available =
      ex.id === DEFAULT_EXCHANGE ? true : validateSources(ex.sourceIds || []).length > 0;
    return {
      id: ex.id,
      name: ex.name,
      currency: ex.currency,
      symbol: ex.currencySymbol,
      timezone: ex.timezone,
      hours: ex.hours,
      source: ex.source,
      flag: ex.flag,
      available,
    };
  });
  // Availability only changes on an env/deploy change (which busts the edge anyway),
  // so this near-static registry can cache for minutes across all users.
  return NextResponse.json(
    { exchanges, default: DEFAULT_EXCHANGE },
    { headers: edgeCache(300, 900) }
  );
});
