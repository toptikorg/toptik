begin;

create table if not exists public.toptik_order_automation_events (
  delivery_id text primary key,
  topic text not null,
  shop_domain text not null,
  order_gid text not null,
  payload_sha256 text not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  received_at timestamptz not null default now()
);

create table if not exists public.toptik_order_automation_jobs (
  order_gid text primary key,
  last_topic text not null,
  state text not null default 'pending' check (state in ('pending','processing','retry','sending','held','sent','failed')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  locked_at timestamptz,
  order_name text,
  payment_transaction_gid text,
  payment_gateway text,
  gross_amount numeric(14,2),
  tax_amount numeric(14,2),
  currency text,
  payment_fee numeric(14,2),
  net_amount numeric(14,2),
  fee_source text,
  invoice_document_id text,
  invoice_number text,
  invoice_created_at timestamptz,
  invoice_status text not null default 'pending',
  gmail_message_id text,
  outbound_message_id text unique,
  alert_gmail_message_id text,
  sent_at timestamptz,
  alert_sent_at timestamptz,
  last_error_code text,
  order_snapshot jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists toptik_order_jobs_due_idx
  on public.toptik_order_automation_jobs (state, next_attempt_at);

alter table public.toptik_order_automation_events enable row level security;
alter table public.toptik_order_automation_jobs enable row level security;
revoke all on public.toptik_order_automation_events from anon, authenticated;
revoke all on public.toptik_order_automation_jobs from anon, authenticated;

create or replace function public.enqueue_toptik_order_event(
  p_delivery_id text, p_topic text, p_shop_domain text, p_order_gid text, p_payload_sha256 text
) returns boolean
language plpgsql security invoker set search_path = public
as $$
declare inserted_count integer;
begin
  if p_delivery_id is null or p_delivery_id = '' or p_order_gid !~ '^gid://shopify/Order/[1-9][0-9]*$' then
    raise exception 'invalid order event';
  end if;
  insert into public.toptik_order_automation_events(delivery_id, topic, shop_domain, order_gid, payload_sha256)
  values (p_delivery_id, p_topic, p_shop_domain, p_order_gid, p_payload_sha256)
  on conflict (delivery_id) do nothing;
  get diagnostics inserted_count = row_count;
  if inserted_count = 0 then return false; end if;

  insert into public.toptik_order_automation_jobs(order_gid, last_topic, state, next_attempt_at)
  values (p_order_gid, p_topic, 'pending', now() + interval '2 minutes')
  on conflict (order_gid) do update set
    last_topic = excluded.last_topic,
    state = case
      when toptik_order_automation_jobs.state = 'sent' and excluded.last_topic not in ('orders/cancelled','refunds/create') then 'sent'
      else 'pending'
    end,
    next_attempt_at = case
      when toptik_order_automation_jobs.state = 'sent' and excluded.last_topic not in ('orders/cancelled','refunds/create') then toptik_order_automation_jobs.next_attempt_at
      else excluded.next_attempt_at
    end,
    updated_at = now();
  return true;
end;
$$;

create or replace function public.claim_toptik_order_jobs(p_limit integer default 5)
returns setof public.toptik_order_automation_jobs
language plpgsql security invoker set search_path = public
as $$
begin
  return query
  with claimed as (
    select order_gid from public.toptik_order_automation_jobs
    where state in ('pending','retry') and next_attempt_at <= now()
      and (locked_at is null or locked_at < now() - interval '10 minutes')
    order by next_attempt_at asc
    for update skip locked
    limit greatest(1, least(coalesce(p_limit, 5), 20))
  )
  update public.toptik_order_automation_jobs jobs
  set state = 'processing', locked_at = now(), attempts = jobs.attempts + 1, updated_at = now()
  from claimed where jobs.order_gid = claimed.order_gid
  returning jobs.*;
end;
$$;

revoke all on function public.enqueue_toptik_order_event(text,text,text,text,text) from public, anon, authenticated;
revoke all on function public.claim_toptik_order_jobs(integer) from public, anon, authenticated;
grant execute on function public.enqueue_toptik_order_event(text,text,text,text,text) to service_role;
grant execute on function public.claim_toptik_order_jobs(integer) to service_role;

commit;

