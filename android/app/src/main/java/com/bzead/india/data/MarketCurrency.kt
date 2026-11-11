package com.bzead.india.data

internal object MarketCurrency {
    fun convert(amount: Double, sourceCurrency: String, targetCurrency: String, rates: Map<String, Double>): Double? {
        if (!amount.isFinite() || amount < 0) return null
        val source = sourceCurrency.trim().uppercase()
        val target = targetCurrency.trim().uppercase()
        if (source.isEmpty() || target.isEmpty()) return null
        if (source == target) return amount
        val from = rates[source]?.takeIf { it.isFinite() && it > 0 } ?: return null
        val to = rates[target]?.takeIf { it.isFinite() && it > 0 } ?: return null
        return (amount / from * to).takeIf { it.isFinite() }
    }

    fun toGbp(amount: Double, sourceCurrency: String, rates: Map<String, Double>): Double? {
        if (!amount.isFinite() || amount <= 0) return null
        return convert(amount, sourceCurrency, "GBP", rates)?.takeIf { it > 0 }
    }

    suspend fun loadRates(token: String): Map<String, Double> {
        val result = SupabaseRest.request(
            "GET",
            "countries?select=currency_code,exchange_rate&is_active=eq.true&exchange_rate=not.is.null",
            token
        )
        if (!result.ok) throw CheckoutException("Unable to load currency exchange rates. Please try again.")
        val rates = mutableMapOf<String, Double>()
        for (index in 0 until result.rows.length()) {
            val row = result.rows.optJSONObject(index) ?: continue
            val code = row.optString("currency_code").trim().uppercase()
            val rate = row.optDouble("exchange_rate", Double.NaN)
            if (code.isNotEmpty() && rate.isFinite() && rate > 0) rates.putIfAbsent(code, rate)
        }
        return rates
    }
}
