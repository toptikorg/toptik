begin;

alter table public.toptik_order_automation_jobs
  add column if not exists financial_status text,
  add column if not exists refunded_amount numeric(14,2) not null default 0;

commit;
