import Stripe from "https://esm.sh/stripe@17.7.0?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { recoverUkHostedCheckout } from "../_shared/uk-hosted-checkout.ts";

const origins = new Set(["https://bzead.uk", "https://www.bzead.uk"]);

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin") || "";
  const json = (body: unknown, status: number) => new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": origins.has(origin) ? origin : "https://bzead.uk",
      "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Vary": "Origin",
    },
  });
  if (req.method === "OPTIONS") return json({}, 200);
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (Number(req.headers.get("content-length") || "0") > 8192) {
    return json({ error: "Request too large" }, 413);
  }
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const stripeKey = Deno.env.get("UK_STRIPE_SECRET_KEY")?.trim();
  const accountId = Deno.env.get("UK_STRIPE_ACCOUNT_ID")?.trim();
  if (!url || !key || !stripeKey || !/^(sk|rk)_(live|test)_/.test(stripeKey) || !accountId) {
    console.error("[verify-uk-hosted-checkout] Missing server configuration");
    return json({ error: "Payment verification is unavailable" }, 500);
  }
  const authorization = req.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return json({ error: "Authentication required" }, 401);
  try {
    const body: unknown = await req.json();
    const sessionId = typeof body === "object" && body !== null && "sessionId" in body
      ? body.sessionId : null;
    if (typeof sessionId !== "string" || !/^cs_(test|live)_[A-Za-z0-9]+$/.test(sessionId)) {
      return json({ error: "Invalid checkout session" }, 400);
    }
    const db = createClient(url, key);
    const { data: auth, error: authError } = await db.auth.getUser(authorization.slice(7));
    if (authError || !auth.user) return json({ error: "Invalid authentication token" }, 401);
    const stripe = new Stripe(stripeKey, {
      apiVersion: "2025-02-24.acacia",
      httpClient: Stripe.createFetchHttpClient(),
    });
    const account = await stripe.accounts.retrieve();
    if (account.id !== accountId) throw new Error("Stripe account does not match UK configuration");
    const result = await recoverUkHostedCheckout(
      stripe, db, sessionId, accountId, /^(sk|rk)_live_/.test(stripeKey), auth.user.id,
    );
    if (result.status === "paid") {
      const { error } = await db.rpc("notify_uk_hosted_order", { p_snapshot_id: result.snapshotId });
      if (error) throw error;
      return json({ status: result.status, orderId: result.orderId, paymentIntentId: result.paymentIntentId }, 200);
    }
    return json(result, 200);
  } catch (error) {
    console.error("[verify-uk-hosted-checkout] Verification failed:", error);
    return json({ error: "Unable to verify payment. If you have paid, do not pay again; contact support." }, 502);
  }
});
