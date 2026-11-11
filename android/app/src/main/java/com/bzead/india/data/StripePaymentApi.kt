package com.bzead.india.data

import org.json.JSONObject
import kotlin.math.roundToLong

internal data class StripePaymentSession(
    val paymentIntentId: String,
    val clientSecret: String,
    val customerId: String,
    val customerSessionClientSecret: String
)

internal object StripePaymentApi {
    fun amountInPence(total: Double): Long {
        if (!total.isFinite() || total <= 0 || total > 50_000.0) {
            throw CheckoutException("Invalid GBP checkout total.")
        }
        return (total * 100).roundToLong().takeIf { it > 0 }
            ?: throw CheckoutException("Invalid GBP checkout total.")
    }

    fun parseSession(body: JSONObject): StripePaymentSession {
        fun requireField(key: String): String = body.optString(key).trim().takeIf { it.isNotEmpty() && it != "null" }
            ?: throw CheckoutException("Stripe payment configuration is incomplete. Please try again.")
        return StripePaymentSession(
            requireField("paymentIntentId"),
            requireField("clientSecret"),
            requireField("customerId"),
            requireField("customerSessionClientSecret")
        )
    }

    suspend fun createSession(token: String, totalGbp: Double, itemCount: Int): StripePaymentSession {
        StorefrontMarket.requireSupportedCheckout()
        if (itemCount <= 0) throw CheckoutException("Your cart is empty.")
        val body = JSONObject()
            .put("amount", amountInPence(totalGbp))
            .put("currency", "gbp")
            .put("client", "native")
            .put("metadata", JSONObject().put("item_count", itemCount.toString()))
        val response = SupabaseRest.callFunction("create-android-payment-intent", token, body)
        if (!response.ok) throw CheckoutException("Unable to initialize secure payment. Please try again.")
        return parseSession(response.json() ?: throw CheckoutException("Stripe payment configuration is invalid."))
    }

    suspend fun saveRecoverySnapshot(
        token: String,
        userId: String,
        session: StripePaymentSession,
        rpcParams: JSONObject
    ) {
        if (rpcParams.optString("p_payment_intent_id") != session.paymentIntentId ||
            rpcParams.optString("p_user_id") != userId ||
            !rpcParams.optString("p_currency").equals("GBP", ignoreCase = true)
        ) {
            throw CheckoutException("Payment recovery details do not match this checkout.")
        }
        if (!CheckoutApi.saveSnapshot(token, userId, session.paymentIntentId, rpcParams)) {
            throw CheckoutException("Unable to prepare secure order recovery. Please try again.")
        }
    }
}
