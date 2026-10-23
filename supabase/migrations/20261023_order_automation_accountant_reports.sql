begin;

create table if not exists public.toptik_accountant_monthly_reports (
  report_month date primary key check (report_month = date_trunc('month', report_month)::date),
  state text not null check (state in ('sending','sent','failed','held')),
  recipient text not null,
  gmail_message_id text,
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  sent_at timestamptz
);

alter table public.toptik_accountant_monthly_reports enable row level security;
revoke all on public.toptik_accountant_monthly_reports from anon, authenticated;

create or replace function public.claim_toptik_accountant_month(p_month date, p_recipient text)
returns boolean
language plpgsql security invoker set search_path = public
as $$
declare inserted_count integer;
begin
  if p_month <> date_trunc('month', p_month)::date or p_recipient is null or p_recipient = '' then
    raise exception 'invalid accountant report claim';
  end if;
  insert into public.toptik_accountant_monthly_reports(report_month, state, recipient)
  values (p_month, 'sending', p_recipient)
  on conflict (report_month) do nothing;
  get diagnostics inserted_count = row_count;
  return inserted_count = 1;
end;
$$;

revoke all on function public.claim_toptik_accountant_month(date,text) from public, anon, authenticated;
grant execute on function public.claim_toptik_accountant_month(date,text) to service_role;

commit;
