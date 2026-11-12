import React, { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Header } from '../../components/layout/Header';
import { Footer } from '../../components/layout/Footer';
import { MobileNav } from '../../components/layout/MobileNav';
import { useAuth } from '../../contexts/AuthContext';
import { supabase } from '../../lib/supabase';

type PaymentState =
  | { status: 'loading' }
  | { status: 'paid'; orderId: string }
  | { status: 'unpaid' | 'expired' }
  | { status: 'error'; message: string };

const UkHostedCheckoutReturn: React.FC = () => {
  const { search } = useLocation();
  const { user, currentAuthUser, loading } = useAuth();
  const [attempt, setAttempt] = useState(0);
  const [payment, setPayment] = useState<PaymentState>({ status: 'loading' });
  const userId = user?.id || currentAuthUser?.userId;
  const sessionId = new URLSearchParams(search).get('session_id') || '';

  useEffect(() => {
    if (loading) return;
    if (!userId) {
      setPayment({ status: 'error', message: 'Please sign in to the account used for this checkout, then return to this page.' });
      return;
    }
    if (!/^cs_(test|live)_[A-Za-z0-9]+$/.test(sessionId)) {
      setPayment({ status: 'error', message: 'This checkout link is invalid. If you have paid, contact support before paying again.' });
      return;
    }
    let cancelled = false;
    setPayment({ status: 'loading' });
    void (async () => {
      const { data, error } = await supabase.functions.invoke('verify-uk-hosted-checkout', {
        body: { sessionId },
      });
      if (cancelled) return;
      if (error || !data || typeof data !== 'object') {
        console.error('[UkHostedCheckoutReturn] Payment verification failed:', error);
        setPayment({ status: 'error', message: 'We could not confirm your payment yet. If you have paid, do not pay again; try checking again or contact support.' });
      } else if (data.status === 'paid' && typeof data.orderId === 'string' && data.orderId) {
        setPayment({ status: 'paid', orderId: data.orderId });
      } else if (data.status === 'unpaid' || data.status === 'expired') {
        setPayment({ status: data.status });
      } else {
        console.error('[UkHostedCheckoutReturn] Unexpected verification response');
        setPayment({ status: 'error', message: 'We could not confirm your payment yet. If you have paid, do not pay again; contact support.' });
      }
    })();
    return () => { cancelled = true; };
  }, [loading, userId, sessionId, attempt]);

  return (
    <div className="min-h-screen bg-[#eaeded] flex flex-col">
      <Header />
      <main className="flex-1 px-4 py-10 pb-24">
        <div className="max-w-xl mx-auto rounded-lg bg-white border border-[#ddd] p-6 text-center">
          {payment.status === 'loading' ? (
            <><h1 className="text-xl font-bold">Checking your payment</h1><p className="mt-3">Please wait while we confirm your order.</p></>
          ) : payment.status === 'paid' ? (
            <><h1 className="text-xl font-bold text-green-700">Payment successful</h1>
              <p className="mt-3">Your order has been confirmed.</p>
              <Link className="inline-block mt-5 text-blue-700 underline" to={`/orders/${encodeURIComponent(payment.orderId)}`}>View your order</Link></>
          ) : (
            <><h1 className="text-xl font-bold">Payment confirmation</h1>
              <p className="mt-3">{payment.status === 'error' ? payment.message : payment.status === 'expired'
                ? 'This checkout session has expired without a confirmed payment.'
                : 'Payment has not been confirmed. If you have already paid, do not pay again; check again or contact support.'}</p>
              <button className="mt-5 px-5 py-2 rounded bg-[#ffd814] font-semibold" onClick={() => setAttempt((value) => value + 1)}>Check again</button></>
          )}
        </div>
      </main>
      <Footer />
      <MobileNav />
    </div>
  );
};

export default UkHostedCheckoutReturn;
