package com.bzead.india.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test

class UkShippingApiTest {
    @Test
    fun calculatesSellerShipmentUsingActualAndVolumetricWeight() {
        val metrics = UkShippingApi.metrics(listOf(UkParcel(2, 0.5, 50.0, 40.0, 30.0)))
        assertEquals(12.0, metrics.weightKg, 0.00001)
        assertEquals(50.0, metrics.lengthCm, 0.0)
    }

    @Test
    fun selectsWeightBandsWithFinalBandInclusiveAndConvertsGrams() {
        val bands = listOf(
            UkRateBand("G", 0.0, 500.0, 2.0, "GBP"),
            UkRateBand("G", 500.0, 1000.0, 4.0, "GBP")
        )
        assertEquals(4.0, UkShippingApi.selectBand(bands, 0.5)!!.amount, 0.0)
        assertEquals(4.0, UkShippingApi.selectBand(bands, 1.0)!!.amount, 0.0)
        assertNull(UkShippingApi.selectBand(bands, 1.001))
    }

    @Test
    fun missingWeightCannotProduceAQuote() {
        assertThrows(CheckoutException::class.java) {
            UkShippingApi.metrics(listOf(UkParcel(1, 0.0, 1.0, 1.0, 1.0)))
        }
    }
}
