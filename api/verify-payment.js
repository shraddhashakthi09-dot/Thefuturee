// api/verify-payment.js
//
// Called immediately after Cashfree Checkout's promise resolves in the
// browser. The browser is NEVER trusted on its own here — this is the
// gate that decides whether the report is allowed to unlock.
//
// Cashfree's popup/modal checkout does not hand the browser a signature to
// relay back (unlike some gateways). So the only thing sent here is "which
// order id did you just try to pay" — whether it actually succeeded is
// re-fetched directly from Cashfree's own servers, never taken on the
// browser's word.

import { getOrder, saveOrder } from '../lib/store.js';
import { cfFetch } from '../lib/cashfree.js';

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return Response.json({ verified: false, error: 'Invalid request.' }, { status: 400 });
  }

  const { orderId } = body || {};
  if (!orderId) {
    return Response.json({ verified: false, error: 'Missing order id.' }, { status: 400 });
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

  // ── Cross-check the order's real status directly with Cashfree ──
  let cfOrder;
  try {
    cfOrder = await cfFetch('/orders/' + encodeURIComponent(orderId));
  } catch (err) {
    console.error('cashfree get-order failed:', err);
    return Response.json(
      { verified: false, error: 'Could not confirm this payment with Cashfree.' },
      { status: 502 }
    );
  }

  const amountMatches =
    Number(cfOrder.order_amount) === Number(order.amount) &&
    cfOrder.order_currency === order.currency;

  if (!amountMatches) {
    return Response.json(
      { verified: false, error: 'Payment details do not match this order.' },
      { status: 400 }
    );
  }

  // order_status is one of ACTIVE (no successful transaction yet), PAID,
  // EXPIRED, TERMINATED, TERMINATION_REQUESTED. Only PAID unlocks anything.
  if (cfOrder.order_status !== 'PAID') {
    return Response.json(
      { verified: false, error: 'Payment is not in a completed state.' },
      { status: 400 }
    );
  }

  await saveOrder(orderId, {
    ...order,
    status: 'paid',
    verifiedAt: Date.now(),
  });

  return Response.json({ verified: true, orderId });
}
