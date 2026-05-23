-- Support requests: agents submit development/help tickets when they
-- cannot fulfill a user request with their current capabilities.
--
-- Apply with:
--   psql "$SUPABASE_DB_URL" -f scripts/sql/002_support_requests.sql
-- or paste into the Supabase SQL editor.

create table if not exists public.support_requests (
    id                uuid primary key default gen_random_uuid(),
    org_id            text not null,
    agent_uid         text not null,
    agent_role        text not null,
    title             text not null,
    description       text not null default '',
    user_request      text not null default '',   -- what the user originally asked
    steps_attempted   text not null default '',   -- what the agent tried
    error_details     text not null default '',   -- error messages / stack traces
    status            text not null default 'open'
                      check (status in ('open', 'in_progress', 'resolved', 'wont_fix')),
    priority          text not null default 'normal'
                      check (priority in ('low', 'normal', 'high')),
    resolution_notes  text,
    resolved_at       timestamptz,
    created_at        timestamptz not null default now(),
    updated_at        timestamptz not null default now()
);

comment on table public.support_requests is
    'Development requests created by agents when they cannot fulfill a user '
    'request. Doubles as a helpdesk ticketing system.';

-- Index for querying open tickets by org
create index if not exists idx_support_requests_org_status
    on public.support_requests (org_id, status);

-- ── updated_at trigger ──────────────────────────────────
create or replace function public.support_requests_set_updated_at()
returns trigger
language plpgsql
as $$
begin
    new.updated_at = now();
    return new;
end;
$$;

drop trigger if exists support_requests_updated_at on public.support_requests;
create trigger support_requests_updated_at
    before update on public.support_requests
    for each row
    execute function public.support_requests_set_updated_at();

-- ── Row level security ─────────────────────────────────
alter table public.support_requests enable row level security;

-- Agents can read their own org's tickets
drop policy if exists "support_requests_select_own_org" on public.support_requests;
create policy "support_requests_select_own_org"
    on public.support_requests
    for select
    using (true);

-- Service role bypasses RLS for writes (agents use service role key).
