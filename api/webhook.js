// api/webhook.js
//
// What a webhook is, in plain terms: instead of your site having to keep
// asking Razorpay "did it work yet? did it work yet?", Razorpay itself
// calls THIS url the moment something happens to a payment — a small
// "here's what just happened" message sent server-to-server, with no
// browser involved. It is the safety net for exactly the case where the
// customer's own browser never gets a chance to tell your site the good
// news (they closed the tab right after paying, their connection died,
// etc.) — Razorpay still lets you know independently.
//
// This endpoint is registered in the Razorpay Dashboard (Account &
// Settings → Webhooks) for the "payment.captured" and "payment.failed"
// events.
//
// Every incoming request is verified against a webhook secret before
// anything in it is trusted — otherwise anyone on the internet could POST
// a fake "payment succeeded" here. Unlike the API auth secret, this one is
// a SEPARATE secret you invent yourself and enter in both the Razorpay
// Dashboard and Vercel's environment variables — they must match exactly.

import crypto from 'node:crypto';
import {
  getOrder,
  saveOrder,
  hasProcessedEvent,
  markEventProcessed,
  getOrderIdByRazorpayOrderId,
} from '../lib/store.js';
import { getWebhookSecret } from '../lib/razorpay.js';

export async function POST(request) {
  // The signature is computed over the exact raw bytes Razorpay sent, so
  // this must read the raw body — not a re-serialized/parsed version.
  const rawBody = await request.text();
  const signature = request.headers.get('x-razorpay-signature') || '';

  let secret;
  try {
    secret = getWebhookSecret();
  } catch (err) {
    console.error('Razorpay webhook: not configured:', err);
    return new Response('Server misconfigured', { status: 500 });
  }

  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');

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
  // Razorpay, like any webhook sender, can deliver the same event more
  // than once (e.g. if your server was briefly unreachable and it
  // retries). Remembering each event's id means processing the same event
  // twice is a no-op the second time, instead of double-counting anything.
  const paymentEntity = payload?.payload?.payment?.entity;
  const eventId =
    (paymentEntity?.id && `pay:${paymentEntity.id}:${payload.event}`) ||
    `${payload.event}:${rawBody.length}`;

  if (await hasProcessedEvent(eventId)) {
    return Response.json({ status: 'already processed' });
  }

  try {
    const eventType = payload.event; // payment.captured / payment.failed
    const razorpayOrderId = paymentEntity?.order_id;

    if (razorpayOrderId) {
      // The store is keyed by OUR orderId everywhere else — this webhook
      // only has Razorpay's own order id, so it's translated via the
      // index written at create-order time. See lib/store.js.
      const orderId = await getOrderIdByRazorpayOrderId(razorpayOrderId);
      const order = orderId ? await getOrder(orderId) : null;

      if (order) {
        if (eventType === 'payment.captured' && order.status !== 'paid') {
          await saveOrder(orderId, {
            ...order,
            status: 'paid',
            razorpayPaymentId: paymentEntity?.id || order.razorpayPaymentId,
            verifiedAt: order.verifiedAt || Date.now(),
            confirmedBy: order.verifiedAt ? order.confirmedBy : 'webhook',
          });
        } else if (eventType === 'payment.failed' && order.status === 'created') {
          await saveOrder(orderId, { ...order, status: 'failed', failedAt: Date.now() });
        }
      }
      // If there's no matching order record, there's nothing unsafe about
      // silently ignoring the event — it just means it's for an order this
      // deployment never created (e.g. a webhook test ping from Razorpay).
    }

    await markEventProcessed(eventId);
    return Response.json({ status: 'ok' });
  } catch (err) {
    console.error('webhook processing error:', err);
    // A non-2xx response tells Razorpay to retry this event later instead
    // of silently dropping it — important since this is the safety net.
    return new Response('Processing error', { status: 500 });
  }
}
