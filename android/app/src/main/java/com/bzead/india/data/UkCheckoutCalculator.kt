package com.bzead.india.data

import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min

internal data class UkCheckoutOffer(
    val type: String,
    val percent: Double = 0.0,
    val minimumQuantity: Int = 0,
    val buyQuantity: Int = 0,
    val freeQuantity: Int = 0
)

internal data class UkCheckoutLine(
    val sellerId: String,
    val originId: String,
    val originIso: String,
    val pickupPostcode: String,
    val quantity: Int,
    val unitPrice: Double,
    val currency: String,
    val parcel: UkParcel,
    val offers: List<UkCheckoutOffer> = emptyList()
)

internal data class UkCheckoutAmounts(
    val subtotal: Double,
    val discount: Double,
    val shipping: Double,
    val total: Double,
    val unitPrices: List<Double>,
    val inrSubtotalByOrigin: Map<String, Double>
)

internal object UkCheckoutCalculator {
    private fun round(value: Double) = floor((value + 2.220446049250313E-16) * 100 + 0.5) / 100

    fun discount(line: UkCheckoutLine): Double {
        val lineTotal = line.unitPrice * line.quantity
        var amount = 0.0
        for (offer in line.offers) {
            val discount = when (offer.type.lowercase()) {
                "special_day", "special_day_offer" ->
                    if (offer.percent > 0 && offer.percent <= 100) lineTotal * offer.percent / 100 else 0.0
                "bundle_discount" ->
                    if (offer.minimumQuantity > 0 && line.quantity >= offer.minimumQuantity &&
                        offer.percent > 0 && offer.percent <= 100
                    ) lineTotal * offer.percent / 100 else 0.0
                "buy_x_get_y" ->
                    if (offer.buyQuantity > 0 && offer.freeQuantity > 0 && line.quantity >= offer.buyQuantity) {
                        min((line.quantity / offer.buyQuantity).toLong() * offer.freeQuantity, line.quantity.toLong()) * line.unitPrice
                    } else 0.0
                else -> 0.0
            }
            amount = max(amount, discount)
        }
        return min(amount, lineTotal)
    }

    suspend fun calculate(
        lines: List<UkCheckoutLine>,
        rates: Map<String, Double>,
        quoteShipping: suspend (List<UkCheckoutLine>) -> UkShippingRate
    ): UkCheckoutAmounts {
        if (lines.isEmpty()) throw CheckoutException("Your cart is empty.")
        if (lines.any {
                it.sellerId.isBlank() || it.originId.isBlank() || it.originIso.isBlank() ||
                    it.quantity <= 0 || it.parcel.quantity != it.quantity ||
                    !it.unitPrice.isFinite() || it.unitPrice <= 0 || it.currency.isBlank()
            }) throw CheckoutException("Product pricing or shipping details are incomplete.")

        fun convert(amount: Double, source: String, target: String): Double =
            MarketCurrency.convert(amount, source, target, rates)
                ?: throw CheckoutException("Live currency conversion is unavailable. Please try again.")

        val subtotalByOrigin = mutableMapOf<String, Double>()
        val unitPrices = mutableListOf<Double>()
        var subtotal = 0.0
        var discount = 0.0
        for (line in lines) {
            val total = line.unitPrice * line.quantity
            if (!total.isFinite()) throw CheckoutException("Invalid product price.")
            unitPrices.add(round(convert(line.unitPrice, line.currency, "GBP")))
            subtotal += round(convert(total, line.currency, "GBP"))
            discount += round(convert(discount(line), line.currency, "GBP"))
            val origin = line.originIso.trim().uppercase()
            subtotalByOrigin[origin] = (subtotalByOrigin[origin] ?: 0.0) + convert(total, line.currency, "INR")
        }

        var shipping = 0.0
        for (group in lines.groupBy { it.sellerId to it.originId }.values) {
            if (group.any { it.originIso != group[0].originIso || it.pickupPostcode != group[0].pickupPostcode }) {
                throw CheckoutException("Inconsistent seller shipping information.")
            }
            val result = quoteShipping(group)
            if (!result.amount.isFinite() || result.amount < 0) throw CheckoutException("Invalid shipping rate.")
            val totalWeight = group.sumOf { max(it.parcel.weightKg, 0.1) * it.quantity }
            if (!totalWeight.isFinite() || totalWeight <= 0) throw CheckoutException("Invalid product weight.")
            for (line in group) {
                val share = result.amount * (max(line.parcel.weightKg, 0.1) * line.quantity / totalWeight)
                shipping += round(convert(share, result.currency, "GBP"))
            }
        }
        subtotal = round(subtotal)
        discount = round(discount)
        shipping = round(shipping)
        val total = round(subtotal - discount + shipping)
        if (!total.isFinite() || total <= 0) throw CheckoutException("Invalid checkout total.")
        return UkCheckoutAmounts(subtotal, discount, shipping, total, unitPrices, subtotalByOrigin)
    }
}
