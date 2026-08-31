// api/webhook.js
//
// What a webhook is, in plain terms: instead of your site having to keep
// asking Cashfree "did it work yet? did it work yet?", Cashfree itself
// calls THIS url the moment something happens to a payment — a small
// "here's what just happened" message sent server-to-server, with no
// browser involved. It is the safety net for exactly the case where the
// customer's own browser never gets a chance to tell your site the good
// news (they closed the tab right after paying, their connection died,
// etc.) — Cashfree still lets you know independently.
//
// This endpoint is registered in the Cashfree Dashboard (see the setup
// guide) for Payment events.
//
// Every incoming request is verified against your Cashfree Client Secret
// before anything in it is trusted — otherwise anyone on the internet
// could POST a fake "payment succeeded" here. Unlike some gateways,
// Cashfree does not require inventing a separate webhook secret: it signs
// webhook requests with the same Client Secret used for API auth.

import crypto from 'node:crypto';
import { getOrder, saveOrder, hasProcessedEvent, markEventProcessed } from '../lib/store.js';
import { getWebhookSecret } from '../lib/cashfree.js';

export async function POST(request) {
  // The signature is computed over "timestamp + the exact raw bytes
  // Cashfree sent", so this must read the raw body — not a
  // re-serialized/parsed version of it. Cashfree explicitly warns that
  // parsing to JSON before this check can alter decimal values.
  const rawBody = await request.text();
  const signature = request.headers.get('x-webhook-signature') || '';
  const timestamp = request.headers.get('x-webhook-timestamp') || '';

  let secret;
  try {
    secret = getWebhookSecret();
  } catch (err) {
    console.error('Cashfree webhook: not configured:', err);
    return new Response('Server misconfigured', { status: 500 });
  }

  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(timestamp + rawBody)
    .digest('base64');

  const providedBuf = Buffer.from(signature, 'utf8');
  const expectedBuf = Buffer.from(expectedSignature, 'utf8');
  const signatureValid =
    providedBuf.length === expectedBuf.length &&
    crypto.timingSafeEqual(providedBuf, expectedBuf);

  if (!signatureValid) {
    // Do not process anything from a request that fails this check.
    return new Response('Invalid signature', { status: 400 });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch (e) {
    return new Response('Invalid JSON', { status: 400 });
  }

  // ── Duplicate-delivery protection ──
  // Cashfree, like any webhook sender, can deliver the same event more
  // than once (e.g. if your server was briefly unreachable and it
  // retries). Remembering each event's id means processing the same event
  // twice is a no-op the second time, instead of double-counting anything.
  const orderData = payload?.data?.order;
  const paymentData = payload?.data?.payment;
  const eventId =
    (paymentData?.cf_payment_id && `pay:${paymentData.cf_payment_id}`) ||
    `${payload.type}:${orderData?.order_id || rawBody.length}:${timestamp}`;

  if (await hasProcessedEvent(eventId)) {
    return Response.json({ status: 'already processed' });
  }

  try {
    const eventType = payload.type; // PAYMENT_SUCCESS_WEBHOOK / PAYMENT_FAILED_WEBHOOK / PAYMENT_USER_DROPPED_WEBHOOK
    const orderId = orderData?.order_id;

    if (orderId) {
      const order = await getOrder(orderId);
      if (order) {
        if (eventType === 'PAYMENT_SUCCESS_WEBHOOK' && order.status !== 'paid') {
          await saveOrder(orderId, {
            ...order,
            status: 'paid',
            verifiedAt: order.verifiedAt || Date.now(),
            confirmedBy: order.verifiedAt ? order.confirmedBy : 'webhook',
          });
        } else if (
          (eventType === 'PAYMENT_FAILED_WEBHOOK' || eventType === 'PAYMENT_USER_DROPPED_WEBHOOK') &&
          order.status === 'created'
        ) {
          await saveOrder(orderId, { ...order, status: 'failed', failedAt: Date.now() });
        }
      }
      // If there's no matching order record, there's nothing unsafe about
      // silently ignoring the event — it just means it's for an order this
      // deployment never created (e.g. a webhook test ping from Cashfree).
    }

    await markEventProcessed(eventId);
    return Response.json({ status: 'ok' });
  } catch (err) {
    console.error('webhook processing error:', err);
    // A non-2xx response tells Cashfree to retry this event later instead
    // of silently dropping it — important since this is the safety net.
    return new Response('Processing error', { status: 500 });
  }
}
