-- Roles catalog: centralized source of truth for agent role profiles.
--
-- Adding a "data-only" role (new prompts + policies, reuses an existing
-- capability) = INSERT a row here + upload blobs to Storage under
-- roles/{slug}/v{version}/. No image rebuild required.
--
-- Adding a "code-backed" role (new scheduler, new bootstrap hook, etc.) =
-- same, plus register a Capability in app/runtime/capabilities_builtin.py
-- and ship a new base image.
--
-- Apply with:
--   psql "$SUPABASE_DB_URL" -f scripts/sql/001_roles_catalog.sql
-- or paste into the Supabase SQL editor.

create table if not exists public.roles (
    slug              text primary key,
    display_name      text not null,
    description       text not null default '',
    icon              text not null default '',
    version           integer not null default 1,
    capability        text not null default 'telegram_chat',
    default_policies  jsonb not null default '{}'::jsonb,
    policy_schema     jsonb not null default '{}'::jsonb,
    is_active         boolean not null default true,
    created_by        text,
    created_at        timestamptz not null default now(),
    updated_at        timestamptz not null default now()
);

comment on table public.roles is
    'Central catalog of agent role profiles. Prompt bodies live in Supabase '
    'Storage at roles/{slug}/v{version}/{system_prompt,identity,boot,playbook_template}.md.';

comment on column public.roles.capability is
    'Name of the runtime capability this role uses. Must match a registered '
    'Capability in app/runtime/capabilities_builtin.py. Default telegram_chat '
    'means prompt-only (no scheduler, no bootstrap hook).';

comment on column public.roles.version is
    'Bootstrap version. Bumped by the console when prompts or policies change. '
    'Agents compare this to manifest.bootstrap_version and run a migration on bump.';

comment on column public.roles.default_policies is
    'Shipped as /data/agent/config/policies.json on first boot. Deep-merged into '
    'existing agent policies on version bump (agent values win on conflicts).';

-- ── updated_at trigger ──────────────────────────────────
create or replace function public.roles_set_updated_at()
returns trigger
language plpgsql
as $$
begin
    new.updated_at = now();
    return new;
end;
$$;

drop trigger if exists roles_updated_at on public.roles;
create trigger roles_updated_at
    before update on public.roles
    for each row
    execute function public.roles_set_updated_at();

-- ── Row level security ─────────────────────────────────
-- Anyone (anon/authenticated) can SELECT active roles — powers the console
-- dropdown without leaking service credentials. Writes are service-role only.
alter table public.roles enable row level security;

drop policy if exists "roles_select_active" on public.roles;
create policy "roles_select_active"
    on public.roles
    for select
    using (is_active = true);

-- Service role bypasses RLS, so no additional write policies are needed.
-- The agent container and the console admin backend both use the service role.
