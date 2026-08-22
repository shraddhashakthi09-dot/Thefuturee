// api/verify-payment.js
//
// Called immediately after Razorpay Checkout's success handler fires in
// the browser. The browser is NEVER trusted on its own here — this is the
// gate that decides whether the report is allowed to unlock.
//
// Two independent checks, both required:
//   1. Signature check — proves the three values (order id, payment id,
//      signature) genuinely came from Razorpay and weren't invented by
//      someone poking the browser console.
//   2. Status check — fetches the payment directly from Razorpay's own
//      servers and confirms it is actually captured, for the right
//      amount, against the right order. This is what stops a stale or
//      tampered "success" callback from unlocking anything.

import crypto from 'node:crypto';
import { getOrder, saveOrder } from '../lib/store.js';
import { getRazorpayInstance } from '../lib/razorpay.js';

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return Response.json({ verified: false, error: 'Invalid request.' }, { status: 400 });
  }

  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = body || {};

  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return Response.json(
      { verified: false, error: 'Missing payment details.' },
      { status: 400 }
    );
  }

  const order = await getOrder(razorpay_order_id);
  if (!order) {
    return Response.json({ verified: false, error: 'Unknown order.' }, { status: 400 });
  }

  // Idempotency: if this exact order+payment was already verified (e.g. the
  // browser retried the request after a flaky connection), say yes again
  // without re-doing the work — this is what makes "the same successful
  // payment is not processed twice" true even under retries.
  if (order.status === 'paid') {
    if (order.paymentId === razorpay_payment_id) {
      return Response.json({ verified: true, orderId: order.orderId });
    }
    // This order was already paid under a *different* payment id — that
    // should never legitimately happen, so treat it as suspicious.
    return Response.json(
      { verified: false, error: 'This order has already been paid.' },
      { status: 409 }
    );
  }

  // ── 1) Signature verification ──
  // Razorpay's documented formula: HMAC-SHA256 of "order_id|payment_id",
  // keyed with your Key Secret, must equal razorpay_signature.
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  const expectedSignature = crypto
    .createHmac('sha256', keySecret)
    .update(razorpay_order_id + '|' + razorpay_payment_id)
    .digest('hex');

  const providedBuf = Buffer.from(razorpay_signature, 'utf8');
  const expectedBuf = Buffer.from(expectedSignature, 'utf8');
  const signatureValid =
    providedBuf.length === expectedBuf.length &&
    crypto.timingSafeEqual(providedBuf, expectedBuf);

  if (!signatureValid) {
    return Response.json(
      { verified: false, error: 'Payment signature could not be verified.' },
      { status: 400 }
    );
  }

  // ── 2) Cross-check the payment's real status with Razorpay ──
  const razorpay = getRazorpayInstance();
  let payment;
  try {
    payment = await razorpay.payments.fetch(razorpay_payment_id);
  } catch (err) {
    console.error('payments.fetch failed:', err);
    return Response.json(
      { verified: false, error: 'Could not confirm this payment with Razorpay.' },
      { status: 502 }
    );
  }

  const amountMatches = payment.amount === order.amount && payment.currency === order.currency;
  const orderMatches = payment.order_id === razorpay_order_id;

  if (!amountMatches || !orderMatches) {
    return Response.json(
      { verified: false, error: 'Payment details do not match this order.' },
      { status: 400 }
    );
  }

  // Standard Checkout auto-captures by default, so this is almost always
  // already 'captured'. If the account has auto-capture turned off, the
  // payment can arrive as 'authorized' (money reserved, not yet settled) —
  // in that case, capture it explicitly rather than unlocking the report
  // for a payment that could still be released back to the customer.
  let finalPayment = payment;
  if (payment.status === 'authorized') {
    try {
      finalPayment = await razorpay.payments.capture(
        razorpay_payment_id,
        order.amount,
        order.currency
      );
    } catch (err) {
      console.error('payments.capture failed:', err);
      return Response.json(
        { verified: false, error: 'Payment could not be captured.' },
        { status: 502 }
      );
    }
  }

  if (finalPayment.status !== 'captured') {
    return Response.json(
      { verified: false, error: 'Payment is not in a completed state.' },
      { status: 400 }
    );
  }

  await saveOrder(razorpay_order_id, {
    ...order,
    status: 'paid',
    paymentId: razorpay_payment_id,
    verifiedAt: Date.now(),
  });

  return Response.json({ verified: true, orderId: razorpay_order_id });
}
