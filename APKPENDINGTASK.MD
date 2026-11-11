# Android UK release: pending tasks

Implement Android checkout using the existing BZEAD UK web app's configuration
and behavior. Do not change the working web checkout or other apps.

- [ ] Connect the UK checkout quote to the shipping address, order summary,
      and payment screens; refresh the quote before payment as the web app does.
- [ ] Match web product and variant pricing, GBP conversion, offers,
      minimum-order rules, and stock checks.
- [ ] Match web shipping rate cards, carrier rates, free-shipping rules,
      delivery options, estimates, and multi-seller or multi-origin orders.
- [ ] Carry the selected shipping option, carrier, service, rate ID, and
      delivery details into payment and the order recovery snapshot.
- [ ] Connect Stripe PaymentSheet to payment initialization using the refreshed
      checkout total and the web app's payment configuration, including saved
      cards and authentication.
- [ ] Save the order recovery snapshot before payment, as the web app does.
- [ ] Confirm payment and create or recover the paid order idempotently; clear
      purchased cart items only after the paid order is confirmed.
- [ ] Handle interrupted payments, app restarts, pending confirmations, and
      retries without asking the customer to pay twice.
- [ ] Remove UK checkout guards only when the complete flow is ready; deploy
      any required Android-specific backend functions without changing the web
      payment function.
- [ ] Verify the completed checkout, then build signed UK release AAB and APK
      files, verify their package and signatures, and make them downloadable.

No separate test project or new tests are requested.
