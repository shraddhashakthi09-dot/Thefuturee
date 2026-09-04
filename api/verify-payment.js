// api/verify-payment.js
//
// Called immediately after Razorpay Checkout's success handler fires in
// the browser. The browser is NEVER trusted on its own here — this is the
// gate that decides whether the report is allowed to unlock.
//
// Razorpay Checkout hands the browser three values once a payment
// completes: razorpay_order_id, razorpay_payment_id, and
// razorpay_signature. The signature is Razorpay's proof that these values
// weren't tampered with in transit — it's recomputed here, server-side,
// using the Key Secret, and compared byte-for-byte. A browser could lie
// about having paid; it cannot forge a signature it doesn't have the
// secret for.

import crypto from 'node:crypto';
import { getOrder, saveOrder } from '../lib/store.js';
import { getKeySecret } from '../lib/razorpay.js';

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return Response.json({ verified: false, error: 'Invalid request.' }, { status: 400 });
  }

  const { orderId, razorpayPaymentId, razorpayOrderId, razorpaySignature } = body || {};
  if (!orderId || !razorpayPaymentId || !razorpayOrderId || !razorpaySignature) {
    return Response.json({ verified: false, error: 'Missing payment details.' }, { status: 400 });
  }

  const order = await getOrder(orderId);
  if (!order) {
    return Response.json({ verified: false, error: 'Unknown order.' }, { status: 400 });
  }

  // Idempotency: if this exact order was already verified (e.g. the
  // browser retried the request after a flaky connection, or the webhook
  // already confirmed it first), say yes again without re-doing the work.
  if (order.status === 'paid') {
    return Response.json({ verified: true, orderId: order.orderId });
  }

  // The order id Checkout reported must be the SAME order this backend
  // created for this transaction — not just any valid-looking order id.
  if (razorpayOrderId !== order.razorpayOrderId) {
    return Response.json(
      { verified: false, error: 'Payment details do not match this order.' },
      { status: 400 }
    );
  }

  // ── Recompute the signature ourselves and compare ──
  // Razorpay's documented formula: HMAC-SHA256("order_id|payment_id", Key Secret), hex-encoded.
  const expectedSignature = crypto
    .createHmac('sha256', getKeySecret())
    .update(razorpayOrderId + '|' + razorpayPaymentId)
    .digest('hex');

  const providedBuf = Buffer.from(razorpaySignature, 'utf8');
  const expectedBuf = Buffer.from(expectedSignature, 'utf8');
  const signatureValid =
    providedBuf.length === expectedBuf.length &&
    crypto.timingSafeEqual(providedBuf, expectedBuf);

  if (!signatureValid) {
    return Response.json(
      { verified: false, error: 'Payment could not be verified.' },
      { status: 400 }
    );
  }

  await saveOrder(orderId, {
    ...order,
    status: 'paid',
    razorpayPaymentId,
    verifiedAt: Date.now(),
    confirmedBy: 'client',
  });

  return Response.json({ verified: true, orderId });
}
