// api/create-order.js
//
// Called when the customer clicks "Unlock Your Complete Report — ₹96".
// This is the ONLY place the price is decided. The amount is a hardcoded
// server-side constant — the browser never gets to say how much to charge.
//
// Flow: customer clicks Pay → this creates a Razorpay Order → the order id
// (plus the public Key ID) is handed back to the browser → the browser
// opens Razorpay Checkout with that order id → customer pays.

import { rzpFetch, getPublicKeyId } from '../lib/razorpay.js';
import { saveOrder, mapRazorpayOrderId } from '../lib/store.js';

// ₹96 — Razorpay's Orders API takes the amount in paise (the smallest
// currency unit, i.e. rupees × 100). This is intentionally the one and
// only place this number is allowed to be defined — everything else reads
// the order back from Razorpay/the store instead of re-stating the price.
const AMOUNT_INR = 96;
const CURRENCY = 'INR';

export async function POST(request) {
  let body = {};
  try {
    body = await request.json();
  } catch (e) {
    // No/invalid JSON body is fine — name is optional, nothing else is
    // read from the request body.
  }

  const customerName =
    typeof body.name === 'string' ? body.name.trim().slice(0, 120) : '';

  try {
    // Our own order id — this is what ties together create-order,
    // verify-payment, the webhook, and the store. Sent to Razorpay as the
    // "receipt" field (just a reference string Razorpay stores alongside
    // the order, not used for auth).
    const orderId = 'tf_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);

    const order = await rzpFetch('/orders', {
      method: 'POST',
      body: {
        amount: AMOUNT_INR * 100, // paise
        currency: CURRENCY,
        receipt: orderId,
        ...(customerName ? { notes: { name: customerName } } : {}),
      },
    });

    if (!order || !order.id) {
      throw new Error('Razorpay did not return an order id');
    }

    // Record this order as "created" (not yet paid) so verify-payment and
    // the webhook both have a shared source of truth to check against.
    await saveOrder(orderId, {
      orderId,
      razorpayOrderId: order.id,
      amount: AMOUNT_INR,
      currency: CURRENCY,
      status: 'created',
      customerName,
      createdAt: Date.now(),
    });

    // The webhook only ever hears Razorpay's own order id — this is the
    // index that lets it map that back to our orderId. See lib/store.js.
    await mapRazorpayOrderId(order.id, orderId);

    return Response.json({
      orderId,
      razorpayOrderId: order.id,
      amount: AMOUNT_INR,
      currency: CURRENCY,
      // The public Key ID — safe to hand to the browser, Razorpay
      // Checkout needs it client-side to open the payment popup.
      key: getPublicKeyId(),
    });
  } catch (err) {
    console.error('create-order error:', err);
    return Response.json(
      { error: 'Could not start the payment. Please try again in a moment.' },
      { status: 500 }
    );
  }
}
