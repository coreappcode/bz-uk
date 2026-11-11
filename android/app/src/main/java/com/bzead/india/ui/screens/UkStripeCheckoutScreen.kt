package com.bzead.india.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.bzead.india.BuildConfig
import com.bzead.india.data.BzeadRepository
import com.bzead.india.ui.components.formatPrice
import com.bzead.india.ui.components.presentStripePaymentSheet
import com.stripe.android.paymentsheet.PaymentSheet
import com.stripe.android.paymentsheet.PaymentSheetResult
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

@Composable
internal fun UkStripeCheckoutScreen(onBack: () -> Unit, onOrderPlaced: (String) -> Unit, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var prepared by remember { mutableStateOf<BzeadRepository.PreparedStripePayment?>(null) }
    var loading by remember { mutableStateOf(true) }
    var message by remember { mutableStateOf<String?>(null) }
    var retry by remember { mutableStateOf(0) }
    var checking by remember { mutableStateOf(false) }
    var presenting by remember { mutableStateOf(false) }
    var paymentSubmitted by remember { mutableStateOf(false) }
    val sheet = remember {
        PaymentSheet.Builder { result ->
            presenting = false
            when (result) {
                is PaymentSheetResult.Completed -> {
                    paymentSubmitted = true
                    val payment = prepared
                    if (payment == null) {
                        message = "Unable to confirm this payment. Please contact support."
                    } else {
                        checking = true
                        scope.launch {
                            try {
                                val orderId = BzeadRepository.confirmStripeOrder(payment)
                                if (orderId != null) onOrderPlaced(orderId)
                                else message = "Payment received; order confirmation is pending. Do not pay again. Reference: ${payment.session.paymentIntentId}"
                            } catch (e: CancellationException) {
                                throw e
                            } catch (e: Exception) {
                                message = "Payment confirmation is pending. Do not pay again. Reference: ${payment.session.paymentIntentId}"
                            } finally {
                                checking = false
                            }
                        }
                    }
                }
                is PaymentSheetResult.Canceled -> message = "Payment cancelled. Check your orders before trying again if you were charged."
                is PaymentSheetResult.Failed -> message = result.error.localizedMessage ?: "Payment failed. Please try again."
            }
        }
    }.build()

    LaunchedEffect(retry) {
        loading = true
        prepared = null
        message = null
        try {
            prepared = BzeadRepository.prepareStripePayment()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            message = e.message ?: "Unable to prepare checkout. Please try again."
        } finally {
            loading = false
        }
    }

    Column(modifier.fillMaxSize().padding(24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Text("Secure checkout")
        if (loading || checking) CircularProgressIndicator()
        prepared?.let { Text("Total: ${formatPrice(it.total)}") }
        message?.let { Text(it) }
        val payment = prepared
        if (payment != null && !checking && !paymentSubmitted) {
            Button(
                onClick = {
                    message = null
                    try {
                        presenting = true
                        presentStripePaymentSheet(context, sheet, BuildConfig.STRIPE_PUBLISHABLE_KEY, payment.session)
                    } catch (e: IllegalArgumentException) {
                        presenting = false
                        message = e.message ?: "Stripe payment configuration is unavailable."
                    }
                },
                modifier = Modifier.fillMaxWidth(),
                enabled = !presenting
            ) { Text("Pay securely with Stripe") }
        } else if (payment == null && !loading && !checking && !paymentSubmitted) {
            Button(onClick = { retry++ }, modifier = Modifier.fillMaxWidth()) { Text("Try again") }
        }
        TextButton(onClick = onBack, enabled = !checking && !presenting) { Text("Back to review") }
    }
}
