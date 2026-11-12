import Stripe from "https://esm.sh/stripe@17.7.0?target=deno";
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
  const webhookSecret = Deno.env.get("UK_STRIPE_WEBHOOK_SECRET")?.trim();
  const accountId = Deno.env.get("UK_STRIPE_ACCOUNT_ID")?.trim();
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!stripeKey || !/^(sk|rk)_(live|test)_/.test(stripeKey) ||
      !webhookSecret || !accountId || !supabaseUrl || !serviceKey) {
    console.error("[uk-hosted-checkout-webhook] Server configuration is incomplete");
    return json({ error: "Webhook not configured" }, 500);
  }
  if (Number(req.headers.get("content-length") || "0") > 1_048_576) {
    return json({ error: "Payload too large" }, 413);
  }
  const signature = req.headers.get("stripe-signature");
  if (!signature) return json({ error: "Missing signature" }, 400);

  const stripe = new Stripe(stripeKey, { httpClient: Stripe.createFetchHttpClient() });
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      await req.text(), signature, webhookSecret, undefined, Stripe.createSubtleCryptoProvider(),
    );
  } catch (error) {
    console.error("[uk-hosted-checkout-webhook] Invalid signature:", error);
    return json({ error: "Invalid signature" }, 400);
  }
  if (event.type !== "checkout.session.completed" &&
      event.type !== "checkout.session.async_payment_succeeded") {
    return json({ received: true }, 200);
  }

  try {
    const livemode = /^(sk|rk)_live_/.test(stripeKey);
    const account = await stripe.accounts.retrieve();
    if (account.id !== accountId || event.livemode !== livemode ||
        (event.account && event.account !== accountId)) {
      throw new Error("Stripe account or mode mismatch");
    }

    const eventSession = event.data.object as Stripe.Checkout.Session;
    const session = await stripe.checkout.sessions.retrieve(eventSession.id);
    if (session.payment_status !== "paid") return json({ received: true }, 200);
    const snapshotId = session.metadata?.uk_checkout_snapshot_id;
    const paymentIntentId = typeof session.payment_intent === "string"
      ? session.payment_intent : session.payment_intent?.id;
    if (!snapshotId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(snapshotId) ||
        !paymentIntentId || !session.amount_total || session.currency !== "gbp" ||
        session.livemode !== livemode) {
      throw new Error("Invalid UK Checkout Session");
    }
    const payment = await stripe.paymentIntents.retrieve(paymentIntentId);
    if (payment.status !== "succeeded" || payment.livemode !== livemode ||
        payment.amount_received !== session.amount_total || payment.currency !== session.currency) {
      throw new Error("Captured payment does not match Checkout Session");
    }
    const db = createClient(supabaseUrl, serviceKey);
    const { data: order, error } = await db.rpc("recover_uk_hosted_checkout", {
      p_snapshot_id: snapshotId,
      p_session_id: session.id,
      p_account_id: accountId,
      p_livemode: livemode,
      p_payment_intent_id: payment.id,
      p_amount_minor: payment.amount_received,
      p_currency: payment.currency,
    });
    if (error || !order?.id) throw error || new Error("Order recovery returned no order");
    return json({ received: true }, 200);
  } catch (error) {
    console.error("[uk-hosted-checkout-webhook] Payment recovery failed:", error);
    return json({ error: "Unable to recover UK order" }, 500);
  }
});
