import Stripe from "https://esm.sh/stripe@14.14.0?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const origins = new Set([
  "https://bzead.uk",
  "https://www.bzead.uk",
]);

function json(body: unknown, status: number, origin: string) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": origins.has(origin) ? origin : "https://bzead.uk",
      "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Vary": "Origin",
    },
  });
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin") || "";
  if (req.method === "OPTIONS") return json({}, 200, origin);
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405, origin);

  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const stripeKey = Deno.env.get("UK_STRIPE_SECRET_KEY")?.trim();
  const accountId = Deno.env.get("UK_STRIPE_ACCOUNT_ID")?.trim();
  if (!url || !serviceKey || !stripeKey || !accountId ||
      !/^(sk|rk)_(live|test)_/.test(stripeKey) || !/^acct_[A-Za-z0-9]+$/.test(accountId)) {
    console.error("[refund-uk-stripe-payment] Missing or invalid server configuration");
    return json({ error: "UK refund configuration is unavailable" }, 500, origin);
  }
  const authorization = req.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return json({ error: "Authentication required" }, 401, origin);
  if (Number(req.headers.get("content-length") || "0") > 8192) {
    return json({ error: "Request too large" }, 413, origin);
  }

  try {
    const body: unknown = await req.json();
    const requestId = typeof body === "object" && body !== null && "refund_request_id" in body
      ? body.refund_request_id : null;
    if (typeof requestId !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)) {
      return json({ error: "Invalid refund request" }, 400, origin);
    }

    const db = createClient(url, serviceKey);
    const token = authorization.slice(7).trim();
    const { data: auth, error: authError } = await db.auth.getUser(token);
    if (authError || !auth.user) return json({ error: "Invalid authentication token" }, 401, origin);
    const { data: profile, error: profileError } = await db.from("profiles")
      .select("role").eq("id", auth.user.id).maybeSingle();
    if (profileError) throw profileError;
    if (profile?.role !== "admin") return json({ error: "Admin role required" }, 403, origin);

    const caller = createClient(url, serviceKey, {
      global: { headers: { Authorization: authorization } },
    });
    const { data: contexts, error: contextError } = await caller.rpc("admin_get_refund_payout_context", {
      p_request_id: requestId,
    });
    if (contextError) throw contextError;
    const context = contexts?.[0];
    if (!context) return json({ error: "Refund request not found" }, 404, origin);
    if (!["accepted", "failed"].includes(context.current_status)) {
      return json({ error: "Refund request is not payable" }, 409, origin);
    }

    const { data: payment, error: paymentError } = await db.from("uk_stripe_order_payments")
      .select("payment_intent_id, stripe_account_id, livemode, amount_minor, currency")
      .eq("order_id", context.order_id).maybeSingle();
    if (paymentError) throw paymentError;
    const livemode = /^(sk|rk)_live_/.test(stripeKey);
    if (!payment || payment.payment_intent_id !== context.payment_intent_id ||
        payment.stripe_account_id !== accountId || payment.livemode !== livemode ||
        payment.currency !== String(context.currency).toLowerCase()) {
      return json({ error: "Refund is not associated with this UK Stripe account" }, 422, origin);
    }

    const amount = Number(context.amount);
    const minor = Math.round(amount * 100);
    if (payment.currency !== "gbp" || !Number.isFinite(amount) ||
        !Number.isSafeInteger(minor) || minor <= 0 || minor > payment.amount_minor) {
      return json({ error: "Invalid refund amount or currency" }, 422, origin);
    }
    const stripe = new Stripe(stripeKey, {
      apiVersion: "2023-10-16",
      httpClient: Stripe.createFetchHttpClient(),
    });
    const account = await stripe.accounts.retrieve();
    if (account.id !== accountId) throw new Error("Configured Stripe account does not match UK account");
    const intent = await stripe.paymentIntents.retrieve(payment.payment_intent_id);
    if (intent.livemode !== livemode || intent.currency !== payment.currency ||
        intent.amount_received !== payment.amount_minor || intent.status !== "succeeded") {
      throw new Error("UK Stripe payment does not match the recorded order");
    }

    const refund = await stripe.refunds.create({
      payment_intent: payment.payment_intent_id,
      amount: minor,
      metadata: {
        refund_request_id: context.request_id,
        refund_number: context.refund_number,
        order_id: context.order_id,
      },
    }, { idempotencyKey: `refund_request_${context.request_id}` });

    const { error: markError } = await caller.rpc("admin_mark_refund_paid", {
      p_request_id: requestId,
      p_stripe_refund_id: refund.id,
      p_stripe_refund_status: refund.status || "pending",
    });
    if (markError) {
      console.error("[refund-uk-stripe-payment] Refund created but database update failed:", markError);
      return json({
        ok: false,
        warning: "Stripe refund created but the database update failed; please reconcile.",
        stripe_refund_id: refund.id,
        status: refund.status,
      }, 207, origin);
    }
    return json({ ok: true, stripe_refund_id: refund.id, status: refund.status }, 200, origin);
  } catch (error) {
    console.error("[refund-uk-stripe-payment] Refund failed:", error);
    return json({ error: "Unable to process UK refund. Check its status before trying again." }, 500, origin);
  }
});
