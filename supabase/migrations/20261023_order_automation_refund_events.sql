begin;

alter table public.toptik_order_automation_events
  add column if not exists refund_amount numeric(14,2),
  add column if not exists refund_currency text;

drop function if exists public.enqueue_toptik_order_event(text,text,text,text,text);

create function public.enqueue_toptik_order_event(
  p_delivery_id text,
  p_topic text,
  p_shop_domain text,
  p_order_gid text,
  p_payload_sha256 text,
  p_refund_amount numeric default null,
  p_refund_currency text default null
) returns boolean
language plpgsql security invoker set search_path = public
as $$
declare inserted_count integer;
begin
  if p_delivery_id is null or p_delivery_id = '' or p_order_gid !~ '^gid://shopify/Order/[1-9][0-9]*$' then
    raise exception 'invalid order event';
  end if;
  if p_topic <> 'refunds/create' and (p_refund_amount is not null or p_refund_currency is not null) then
    raise exception 'refund data on non-refund event';
  end if;
  if (p_refund_amount is null) <> (p_refund_currency is null) or coalesce(p_refund_amount, 0) < 0 then
    raise exception 'invalid refund data';
  end if;

  insert into public.toptik_order_automation_events(
    delivery_id, topic, shop_domain, order_gid, payload_sha256, refund_amount, refund_currency
  ) values (
    p_delivery_id, p_topic, p_shop_domain, p_order_gid, p_payload_sha256, p_refund_amount, p_refund_currency
  ) on conflict (delivery_id) do nothing;
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

revoke all on function public.enqueue_toptik_order_event(text,text,text,text,text,numeric,text) from public, anon, authenticated;
grant execute on function public.enqueue_toptik_order_event(text,text,text,text,text,numeric,text) to service_role;

commit;
