-- Phase 1 + 2 schema additions.
-- events    — durable activity history (scan progress, signals, promotions, outcomes)
-- knowledge — qualitative knowledge base the agent reads + reinforces

-- 8. events
create table if not exists events (
  id         uuid primary key default gen_random_uuid(),
  scan_id    uuid,
  type       text,
  symbol     text,
  message    text,
  data       jsonb,
  created_at timestamptz default now()
);

create index if not exists events_created_at_idx on events (created_at desc);
create index if not exists events_scan_id_idx    on events (scan_id);

-- 9. knowledge
create table if not exists knowledge (
  id         uuid primary key default gen_random_uuid(),
  kind       text,            -- 'symbol_note' | 'sector_note' | 'concept' | 'kpi'
  key        text unique,     -- e.g. 'SYMBOL_NOTE:NABIL', 'SECTOR_NOTE:hydropower', 'KPI:RSI'
  content    text,
  source     text,
  confidence numeric default 0.5,
  refs       jsonb,
  version    int default 1,
  updated_at timestamptz default now()
);

create index if not exists knowledge_kind_idx on knowledge (kind);
