// lib/store.js
//
// Tiny persistence layer used to remember, across requests, which orders
// have actually been paid for. Vercel serverless functions are stateless —
// each invocation can run on a fresh instance with no memory of the last
// one — so without a real store there would be no reliable way to answer
// "has this order already been paid?" That answer is what stops:
//   - the same successful payment being unlocked/processed twice
//   - a webhook that Cashfree delivers more than once being acted on twice
//   - a customer being able to fake "payment succeeded" from the browser
//
// Backed by Upstash Redis (added to the Vercel project via the Vercel
// Marketplace / "Redis on Vercel" integration, which auto-fills these
// env vars — see the setup guide).

import { Redis } from '@upstash/redis';

let cachedRedis = null;

function getRedis() {
  if (cachedRedis) return cachedRedis;

  // The Vercel Redis/Upstash integration can name these either way
  // depending on how it was added — support both.
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    throw new Error(
      'Redis storage is not configured. Add the "Redis on Vercel" (Upstash) ' +
      'integration to this project — see the setup guide.'
    );
  }

  cachedRedis = new Redis({ url, token });
  return cachedRedis;
}

const ORDER_PREFIX = 'tf_order:';
const EVENT_PREFIX = 'tf_webhook_event:';

// Orders are kept for 90 days — long enough to handle support/refund
// questions about a specific ₹96 purchase, short enough not to pile up.
const ORDER_TTL_SECONDS = 60 * 60 * 24 * 90;

// Webhook event de-duplication only needs to survive Cashfree's own retry
// window, so 7 days is comfortably generous.
const EVENT_TTL_SECONDS = 60 * 60 * 24 * 7;

export async function saveOrder(orderId, data) {
  await getRedis().set(ORDER_PREFIX + orderId, data, { ex: ORDER_TTL_SECONDS });
}

export async function getOrder(orderId) {
  const raw = await getRedis().get(ORDER_PREFIX + orderId);
  if (!raw) return null;
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

export async function hasProcessedEvent(eventId) {
  const v = await getRedis().get(EVENT_PREFIX + eventId);
  return !!v;
}

export async function markEventProcessed(eventId) {
  await getRedis().set(EVENT_PREFIX + eventId, '1', { ex: EVENT_TTL_SECONDS });
}
