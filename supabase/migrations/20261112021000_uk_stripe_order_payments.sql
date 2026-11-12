begin;

-- Only the UK payment backend may associate an order with the UK Stripe account.
create table public.uk_stripe_order_payments (
  order_id uuid primary key references public.orders(id),
  payment_intent_id text not null unique,
  stripe_account_id text not null,
  livemode boolean not null,
  amount_minor bigint not null check (amount_minor > 0),
  currency text not null check (currency ~ '^[a-z]{3}$'),
  created_at timestamptz not null default now()
);

alter table public.uk_stripe_order_payments enable row level security;
revoke all on public.uk_stripe_order_payments from public, anon, authenticated;
grant select, insert, update on public.uk_stripe_order_payments to service_role;

create function public.sync_uk_stripe_refund_status(
  p_request_id uuid,
  p_order_id uuid,
  p_refund_id text,
  p_status text,
  p_failure_reason text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.refund_requests r
  set stripe_refund_status = p_status,
      stripe_failure_reason = nullif(trim(coalesce(p_failure_reason, '')), ''),
      status = case
        when p_status in ('failed', 'canceled') then 'failed'
        when p_status = 'succeeded' then 'paid'
        else r.status
      end
  where r.id = p_request_id and r.order_id = p_order_id
    and r.stripe_refund_id = p_refund_id
    and exists (
      select 1 from public.uk_stripe_order_payments p where p.order_id = r.order_id
    );
  if not found then
    raise exception 'UK refund request not found or not yet associated';
  end if;
end;
$$;

revoke all on function public.sync_uk_stripe_refund_status(uuid, uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function public.sync_uk_stripe_refund_status(uuid, uuid, text, text, text)
  to service_role;

commit;
