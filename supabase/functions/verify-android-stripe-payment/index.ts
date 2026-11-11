import Stripe from "https://esm.sh/stripe@20.0.0?target=deno";
import { verifyPayment } from "./payment.ts";

Deno.serve(async (req: Request) => {
  const json = (body: Record<string, unknown>, status: number) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (Number(req.headers.get("content-length") || "0") > 65_536) return json({ error: "Request too large" }, 413);

  const authorization = req.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return json({ error: "Authentication required" }, 401);
  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
  if (!url || !serviceKey || !stripeKey || !/^(sk|rk)_(live|test)_/.test(stripeKey)) {
    console.error("[verify-android-stripe-payment] Missing server configuration");
    return json({ error: "Server configuration error" }, 500);
  }

  try {
    const userResponse = await fetch(`${url}/auth/v1/user`, {
      headers: { apikey: serviceKey, Authorization: authorization },
    });
    if (userResponse.status === 401 || userResponse.status === 403) {
      return json({ error: "Invalid authentication token" }, 401);
    }
    if (!userResponse.ok) throw new Error(`Authentication service returned ${userResponse.status}`);
    const user = await userResponse.json() as { id?: string };
    if (!user.id) return json({ error: "Invalid authentication token" }, 401);

    let body: unknown;
    try {
      body = await req.json();
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      return json({ error: "Invalid request" }, 400);
    }
    const paymentIntentId = typeof body === "object" && body !== null && "paymentIntentId" in body
      ? body.paymentIntentId : null;
    if (typeof paymentIntentId !== "string" || !/^pi_[A-Za-z0-9]{1,128}$/.test(paymentIntentId)) {
      return json({ error: "Invalid payment reference" }, 400);
    }
    const expectedAmount = typeof body === "object" && body !== null && "expectedAmount" in body
      ? body.expectedAmount : null;
    if (typeof expectedAmount !== "number" || !Number.isSafeInteger(expectedAmount) ||
      expectedAmount <= 0 || expectedAmount > 5_000_000) {
      return json({ error: "Invalid payment amount" }, 400);
    }

    const stripe = new Stripe(stripeKey, { httpClient: Stripe.createFetchHttpClient() });
    const payment = await stripe.paymentIntents.retrieve(paymentIntentId);
    const result = verifyPayment(payment, user.id, paymentIntentId, /^(sk|rk)_live_/.test(stripeKey), expectedAmount);
    if (result === "mismatch") {
      console.error("[verify-android-stripe-payment] Payment does not match authenticated UK checkout");
      return json({ error: "Payment could not be verified" }, 403);
    }
    return json({ status: result }, 200);
  } catch (error) {
    console.error("[verify-android-stripe-payment] Verification failed:", error);
    return json({ error: "Unable to verify payment. Please try again." }, 502);
  }
});
