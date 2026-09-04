// lib/razorpay.js
//
// Shared Razorpay config + a small fetch wrapper. The Key Secret must
// only ever exist on the server — never import this file from anything
// that runs in the browser.

function getCreds() {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;

  if (!keyId || !keySecret) {
    throw new Error(
      'Razorpay is not configured. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET ' +
      'as environment variables (Vercel → Project → Settings → Environment Variables).'
    );
  }
  return { keyId, keySecret };
}

const BASE_URL = 'https://api.razorpay.com/v1';

// Small wrapper around Razorpay's REST API. No SDK dependency needed —
// every call here is a plain authenticated fetch (HTTP Basic Auth with the
// Key ID / Key Secret), which keeps the backend lighter and avoids
// depending on a Node SDK's exact method names.
export async function rzpFetch(path, { method = 'GET', body } = {}) {
  const { keyId, keySecret } = getCreds();
  const auth = Buffer.from(keyId + ':' + keySecret).toString('base64');

  const resp = await fetch(BASE_URL + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Basic ' + auth,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await resp.json().catch(() => ({}));

  if (!resp.ok) {
    const err = new Error(
      (data && data.error && data.error.description) || `Razorpay API error (${resp.status})`
    );
    err.status = resp.status;
    err.data = data;
    throw err;
  }

  return data;
}

// The Key ID (not the secret) is what the browser needs to open Razorpay
// Checkout. It's a public identifier, not a credential — safe to hand to
// the browser, the same idea as a Stripe "publishable key."
export function getPublicKeyId() {
  return getCreds().keyId;
}

// The Key Secret — used both for server-side API auth (above) and for
// recomputing the signature Checkout hands back to the browser after a
// payment, to prove it wasn't tampered with.
export function getKeySecret() {
  return getCreds().keySecret;
}

// Razorpay webhooks are signed with a SEPARATE secret from the Key Secret
// — this one you invent yourself and enter in two places: the Razorpay
// Dashboard's Webhook settings, and this env var. They must match exactly.
export function getWebhookSecret() {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) {
    throw new Error(
      'RAZORPAY_WEBHOOK_SECRET is not set. Create a webhook in the Razorpay ' +
      'Dashboard (Account & Settings → Webhooks), copy the secret you set ' +
      'there, and set it as an environment variable in Vercel.'
    );
  }
  return secret;
}
