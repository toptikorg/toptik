begin;

create table if not exists public.toptik_order_automation_health (
  id boolean primary key default true check (id),
  last_worker_started_at timestamptz,
  last_worker_completed_at timestamptz,
  last_worker_error_code text,
  last_webhook_check_at timestamptz,
  last_audit_started_at timestamptz,
  last_audit_completed_at timestamptz,
  audit_status text not null default 'unknown' check (audit_status in ('unknown','healthy','unhealthy')),
  issue_codes jsonb not null default '[]'::jsonb check (jsonb_typeof(issue_codes) = 'array'),
  updated_at timestamptz not null default now()
);

insert into public.toptik_order_automation_health(id)
values (true)
on conflict (id) do nothing;

alter table public.toptik_order_automation_health enable row level security;
revoke all on public.toptik_order_automation_health from anon, authenticated;
grant select (id, last_audit_completed_at, audit_status, issue_codes)
  on public.toptik_order_automation_health to anon;
create policy "public reads aggregate order health only"
  on public.toptik_order_automation_health
  for select
  to anon
  using (id = true);

commit;
