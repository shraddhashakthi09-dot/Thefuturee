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
// This endpoint is registered in the Razorpay Dashboard (see the setup
// guide) for events: payment.captured, payment.failed, order.paid.
//
// Every incoming request is verified against RAZORPAY_WEBHOOK_SECRET
// before anything in it is trusted — otherwise anyone on the internet
// could POST a fake "payment succeeded" here.

import crypto from 'node:crypto';
import { getOrder, saveOrder, hasProcessedEvent, markEventProcessed } from '../lib/store.js';

export async function POST(request) {
  // The signature is computed over the exact raw bytes Razorpay sent, so
  // this must read the raw body — not a re-serialized/parsed version of it.
  const rawBody = await request.text();
  const signature = request.headers.get('x-razorpay-signature') || '';
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;

  if (!secret) {
    console.error('RAZORPAY_WEBHOOK_SECRET is not configured.');
    return new Response('Server misconfigured', { status: 500 });
  }

  const expectedSignature = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
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
  // Razorpay explicitly says the same event can be sent more than once
  // (e.g. if your server was briefly unreachable and it retries). Using
  // Razorpay's own event id means processing the same event twice is a
  // no-op the second time, instead of double-counting anything.
  const paymentEntity = payload?.payload?.payment?.entity;
  const orderEntity = payload?.payload?.order?.entity;
  const eventId =
    request.headers.get('x-razorpay-event-id') ||
    `${payload.event}:${paymentEntity?.id || orderEntity?.id || rawBody.length}`;

  if (await hasProcessedEvent(eventId)) {
    return Response.json({ status: 'already processed' });
  }

  try {
    const eventType = payload.event;
    const orderId = paymentEntity?.order_id || orderEntity?.id;

    if (orderId) {
      const order = await getOrder(orderId);
      if (order) {
        if ((eventType === 'payment.captured' || eventType === 'order.paid') && order.status !== 'paid') {
          await saveOrder(orderId, {
            ...order,
            status: 'paid',
            paymentId: paymentEntity?.id || order.paymentId,
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
