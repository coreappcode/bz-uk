begin;

create table public.uk_hosted_checkout_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  stripe_session_id text unique,
  stripe_account_id text not null,
  livemode boolean not null,
  amount_minor bigint not null check (amount_minor > 0),
  currency text not null check (currency = 'gbp'),
  rpc_params jsonb not null check (jsonb_typeof(rpc_params) = 'object'),
  order_id uuid references public.orders(id),
  payment_intent_id text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.uk_hosted_checkout_sessions enable row level security;
revoke all on public.uk_hosted_checkout_sessions from public, anon, authenticated;
grant select, insert, update on public.uk_hosted_checkout_sessions to service_role;

create function public.recover_uk_hosted_checkout(
  p_snapshot_id uuid,
  p_session_id text,
  p_account_id text,
  p_livemode boolean,
  p_payment_intent_id text,
  p_amount_minor bigint,
  p_currency text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_snapshot public.uk_hosted_checkout_sessions%rowtype;
  v_rpc jsonb;
  v_result jsonb;
  v_order public.orders%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Unauthorized';
  end if;
  if p_session_id !~ '^cs_[A-Za-z0-9_]+$'
    or p_payment_intent_id !~ '^pi_[A-Za-z0-9]+$'
    or p_amount_minor is null or p_amount_minor <= 0 then
    raise exception 'Invalid payment details';
  end if;

  select * into v_snapshot from public.uk_hosted_checkout_sessions
    where id = p_snapshot_id for update;
  if not found or v_snapshot.stripe_session_id is distinct from p_session_id
    or v_snapshot.stripe_account_id is distinct from p_account_id
    or v_snapshot.livemode is distinct from p_livemode
    or v_snapshot.amount_minor is distinct from p_amount_minor
    or v_snapshot.currency is distinct from p_currency then
    raise exception 'Checkout session does not match snapshot';
  end if;

  v_rpc := v_snapshot.rpc_params;
  if v_rpc->>'p_user_id' is distinct from v_snapshot.user_id::text
    or lower(coalesce(v_rpc->>'p_currency', '')) is distinct from p_currency
    or jsonb_typeof(v_rpc->'p_items') is distinct from 'array'
    or jsonb_array_length(v_rpc->'p_items') = 0 then
    raise exception 'Invalid checkout snapshot';
  end if;

  if v_snapshot.order_id is null then
    perform set_config('request.jwt.claim.sub', v_snapshot.user_id::text, true);
    perform set_config('request.jwt.claim.role', 'authenticated', true);
    v_result := public.create_order_secure(
      v_snapshot.user_id,
      v_rpc->'p_items',
      v_rpc->'p_shipping_address',
      case when jsonb_typeof(v_rpc->'p_billing_address') = 'object' then v_rpc->'p_billing_address' else null end,
      nullif(v_rpc->>'p_phone', ''),
      nullif(v_rpc->>'p_notes', ''),
      p_payment_intent_id,
      'card',
      'pending',
      'processing',
      upper(p_currency),
      coalesce(nullif(v_rpc->>'p_shipping_charge', '')::numeric, 0),
      coalesce(nullif(v_rpc->>'p_actual_shipping_cost', '')::numeric, 0),
      coalesce(nullif(v_rpc->>'p_platform_shipping_margin', '')::numeric, 0),
      null,
      'stripe_' || p_payment_intent_id,
      nullif(v_rpc->>'p_shipping_carrier', ''),
      nullif(v_rpc->>'p_shipping_service_level', ''),
      nullif(v_rpc->>'p_shipping_provider', ''),
      nullif(v_rpc->>'p_shipping_rate_id', ''),
      nullif(v_rpc->>'p_expected_delivery_date', '')::timestamptz,
      nullif(v_rpc->>'p_expected_delivery_days', '')::integer,
      nullif(v_rpc->>'p_country', '')
    );
    select * into v_order from public.orders where id = (v_result->>'id')::uuid for update;
  else
    if v_snapshot.payment_intent_id is distinct from p_payment_intent_id then
      raise exception 'Payment intent does not match recovered order';
    end if;
    select * into v_order from public.orders where id = v_snapshot.order_id for update;
  end if;

  if v_order.id is null or v_order.user_id is distinct from v_snapshot.user_id
    or v_order.payment_intent_id is distinct from p_payment_intent_id
    or lower(v_order.currency) is distinct from p_currency
    or lower(coalesce(v_order.status, '')) in ('cancelled', 'canceled')
    or lower(coalesce(v_order.payment_status, '')) not in ('pending', 'completed', 'paid', 'succeeded') then
    raise exception 'Recovered order does not match payment';
  end if;

  update public.orders set payment_status = 'completed', updated_at = now()
    where id = v_order.id and payment_status is distinct from 'completed';
  insert into public.payment_intents (order_id, stripe_payment_intent_id, status, amount, currency)
    values (v_order.id, p_payment_intent_id, 'succeeded', p_amount_minor::numeric / 100, p_currency)
    on conflict (stripe_payment_intent_id) do nothing;
  if not exists (
    select 1 from public.payment_intents where stripe_payment_intent_id = p_payment_intent_id
      and order_id = v_order.id and amount = p_amount_minor::numeric / 100 and currency = p_currency
  ) then
    raise exception 'Payment record does not match order';
  end if;
  update public.payment_intents set status = 'succeeded'
    where stripe_payment_intent_id = p_payment_intent_id and status is distinct from 'succeeded';
  update public.uk_hosted_checkout_sessions
    set order_id = v_order.id, payment_intent_id = p_payment_intent_id, updated_at = now()
    where id = v_snapshot.id;
  return jsonb_build_object('id', v_order.id);
end;
$$;

revoke all on function public.recover_uk_hosted_checkout(uuid, text, text, boolean, text, bigint, text)
  from public, anon, authenticated;
grant execute on function public.recover_uk_hosted_checkout(uuid, text, text, boolean, text, bigint, text)
  to service_role;

commit;
