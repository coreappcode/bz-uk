import Stripe from "https://esm.sh/stripe@14.14.0?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const stripeKey = Deno.env.get("UK_STRIPE_SECRET_KEY")?.trim();
  const webhookSecret = Deno.env.get("UK_STRIPE_REFUND_WEBHOOK_SECRET")?.trim();
  const accountId = Deno.env.get("UK_STRIPE_ACCOUNT_ID")?.trim();
  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!stripeKey || !/^(sk|rk)_(live|test)_/.test(stripeKey) ||
      !webhookSecret || !accountId || !url || !serviceKey) {
    console.error("[uk-stripe-refund-webhook] Missing server configuration");
    return json({ error: "Server configuration error" }, 500);
  }
  const signature = req.headers.get("stripe-signature");
  if (!signature) return json({ error: "Missing signature" }, 400);

  const stripe = new Stripe(stripeKey, {
    apiVersion: "2023-10-16",
    httpClient: Stripe.createFetchHttpClient(),
  });
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      await req.text(),
      signature,
      webhookSecret,
      undefined,
      Stripe.createSubtleCryptoProvider(),
    );
  } catch (error) {
    console.error("[uk-stripe-refund-webhook] Invalid signature:", error);
    return json({ error: "Invalid signature" }, 400);
  }

  if (!["refund.created", "refund.updated", "refund.failed"].includes(event.type)) {
    return json({ received: true }, 200);
  }
  const livemode = /^(sk|rk)_live_/.test(stripeKey);
  if (event.livemode !== livemode || (event.account && event.account !== accountId)) {
    console.error("[uk-stripe-refund-webhook] Event account or mode mismatch");
    return json({ error: "Event account mismatch" }, 400);
  }

  try {
    const account = await stripe.accounts.retrieve();
    if (account.id !== accountId) throw new Error("Configured Stripe account does not match UK account");
    const eventRefund = event.data.object as Stripe.Refund;
    const refund = await stripe.refunds.retrieve(eventRefund.id);
    const requestId = refund.metadata?.refund_request_id;
    const orderId = refund.metadata?.order_id;
    if (!requestId || !orderId) return json({ received: true }, 200);

    const paymentIntentId = typeof refund.payment_intent === "string"
      ? refund.payment_intent : refund.payment_intent?.id;
    const db = createClient(url, serviceKey);
    const { data: payment, error: paymentError } = await db.from("uk_stripe_order_payments")
      .select("payment_intent_id, stripe_account_id, livemode, currency")
      .eq("order_id", orderId).maybeSingle();
    if (paymentError) throw paymentError;
    if (!payment || payment.payment_intent_id !== paymentIntentId ||
        payment.stripe_account_id !== accountId || payment.livemode !== livemode ||
        payment.currency !== refund.currency) {
      throw new Error("Refund does not match a UK order payment");
    }

    const { data: request, error: requestError } = await db.from("refund_requests")
      .select("order_id, stripe_refund_id").eq("id", requestId).maybeSingle();
    if (requestError) throw requestError;
    if (!request || request.order_id !== orderId || request.stripe_refund_id !== refund.id) {
      throw new Error("Refund has not yet been associated with the request");
    }
    const { error: updateError } = await db.rpc("sync_uk_stripe_refund_status", {
      p_request_id: requestId,
      p_order_id: orderId,
      p_refund_id: refund.id,
      p_status: refund.status || "pending",
      p_failure_reason: refund.failure_reason || null,
    });
    if (updateError) throw updateError;
    return json({ received: true }, 200);
  } catch (error) {
    console.error("[uk-stripe-refund-webhook] Processing failed:", error);
    return json({ error: "Unable to update refund" }, 500);
  }
});
