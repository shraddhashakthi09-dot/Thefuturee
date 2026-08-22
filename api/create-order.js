// api/create-order.js
//
// Called when the customer clicks "Unlock Your Complete Report — ₹96".
// This is the ONLY place the price is decided. The amount is a hardcoded
// server-side constant — the browser never gets to say how much to charge.
//
// Flow: customer clicks Pay → this creates a Razorpay Order → the order_id
// is handed back to the browser → the browser opens Razorpay Checkout with
// that order_id → customer pays.

import { getRazorpayInstance } from '../lib/razorpay.js';
import { saveOrder } from '../lib/store.js';

// ₹96.00 in paise (the smallest currency unit Razorpay's Orders API expects).
// 96 * 100 = 9600. This is intentionally the one and only place this number
// is allowed to be defined — everything else reads the order back from
// Razorpay/the store instead of re-stating the price.
const AMOUNT_PAISE = 9600;
const CURRENCY = 'INR';

export async function POST(request) {
  let body = {};
  try {
    body = await request.json();
  } catch (e) {
    // No/invalid JSON body is fine — name is optional, everything else is fixed.
  }

  const customerName =
    typeof body.name === 'string' ? body.name.trim().slice(0, 120) : '';

  try {
    const razorpay = getRazorpayInstance();

    // Receipt is just an internal reference string for your own records —
    // it is not shown to the customer.
    const receipt = 'rcpt_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);

    const order = await razorpay.orders.create({
      amount: AMOUNT_PAISE,
      currency: CURRENCY,
      receipt,
      notes: customerName ? { customer_name: customerName } : undefined,
    });

    // Record this order as "created" (not yet paid) so verify-payment and
    // the webhook both have a shared source of truth to check against.
    await saveOrder(order.id, {
      orderId: order.id,
      amount: AMOUNT_PAISE,
      currency: CURRENCY,
      status: 'created',
      customerName,
      createdAt: Date.now(),
    });

    return Response.json({
      orderId: order.id,
      amount: AMOUNT_PAISE,
      currency: CURRENCY,
      // The Key ID is safe to send to the browser — it identifies your
      // account, it cannot be used to charge or move money on its own.
      keyId: process.env.RAZORPAY_KEY_ID,
    });
  } catch (err) {
    console.error('create-order error:', err);
    return Response.json(
      { error: 'Could not start the payment. Please try again in a moment.' },
      { status: 500 }
    );
  }
}
