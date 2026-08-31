// api/create-order.js
//
// Called when the customer clicks "Unlock Your Complete Report — ₹96".
// This is the ONLY place the price is decided. The amount is a hardcoded
// server-side constant — the browser never gets to say how much to charge.
//
// Flow: customer clicks Pay → this creates a Cashfree Order → a
// payment_session_id is handed back to the browser → the browser opens
// Cashfree Checkout with that session id → customer pays.

import { cfFetch, getEnvironment } from '../lib/cashfree.js';
import { saveOrder } from '../lib/store.js';

// ₹96 — Cashfree's Orders API takes the amount in whole rupees (decimal),
// not paise/the smallest currency unit. This is intentionally the one and
// only place this number is allowed to be defined — everything else reads
// the order back from Cashfree/the store instead of re-stating the price.
const AMOUNT_INR = 96;
const CURRENCY = 'INR';

// Cashfree's Orders API requires a customer_phone in customer_details —
// this site deliberately does not collect a phone number from the
// customer (no field for it on the form), so a synthetic placeholder is
// generated to satisfy Cashfree's schema. This is not a real contact
// number and is never shown to or used to contact the customer; it
// exists purely because the field is mandatory on Cashfree's side.
//
// Generated fresh, per order, instead of a single fixed value — at low
// volume a fixed placeholder is invisible, but at high volume the exact
// same 10-digit number appearing behind every single transaction is a
// textbook fraud/risk-system pattern. Randomizing it removes that
// pattern while still not requiring any real user data to be collected.
function generatePlaceholderPhone() {
  // Valid-format Indian mobile numbers start with 6, 7, 8, or 9.
  const firstDigit = String(6 + Math.floor(Math.random() * 4));
  let rest = '';
  for (let i = 0; i < 9; i++) rest += String(Math.floor(Math.random() * 10));
  return firstDigit + rest;
}

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
    // Our own order id — Cashfree lets the merchant supply one (3-45
    // alphanumeric characters, hyphens/underscores allowed). This is what
    // ties together create-order, verify-payment, the webhook, and the
    // store.
    const orderId = 'tf_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    // customer_id just needs to be a unique alphanumeric handle — nothing
    // about this customer's real identity needs to be encoded in it.
    const customerId = 'cust_' + Math.random().toString(36).slice(2, 12);

    const order = await cfFetch('/orders', {
      method: 'POST',
      body: {
        order_id: orderId,
        order_amount: AMOUNT_INR,
        order_currency: CURRENCY,
        customer_details: {
          customer_id: customerId,
          customer_phone: generatePlaceholderPhone(),
          ...(customerName ? { customer_name: customerName } : {}),
        },
      },
    });

    if (!order || !order.payment_session_id) {
      throw new Error('Cashfree did not return a payment_session_id');
    }

    // Record this order as "created" (not yet paid) so verify-payment and
    // the webhook both have a shared source of truth to check against.
    await saveOrder(orderId, {
      orderId,
      amount: AMOUNT_INR,
      currency: CURRENCY,
      status: 'created',
      customerName,
      createdAt: Date.now(),
    });

    return Response.json({
      orderId,
      paymentSessionId: order.payment_session_id,
      amount: AMOUNT_INR,
      currency: CURRENCY,
      // Tells the browser which Cashfree JS SDK mode to initialize — not
      // secret, it just has to match the account the order was created
      // against (sandbox vs production).
      environment: getEnvironment(),
    });
  } catch (err) {
    console.error('create-order error:', err);
    return Response.json(
      { error: 'Could not start the payment. Please try again in a moment.' },
      { status: 500 }
    );
  }
}
