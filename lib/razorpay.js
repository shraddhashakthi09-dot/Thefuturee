// lib/razorpay.js
//
// One shared Razorpay SDK client, built from the two server-only secrets.
// Never import this file from anything that runs in the browser — the
// Key Secret must only ever exist on the server.

import Razorpay from 'razorpay';

let cachedInstance = null;

export function getRazorpayInstance() {
  if (cachedInstance) return cachedInstance;

  const key_id = process.env.RAZORPAY_KEY_ID;
  const key_secret = process.env.RAZORPAY_KEY_SECRET;

  if (!key_id || !key_secret) {
    throw new Error(
      'Razorpay is not configured. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET ' +
      'as environment variables (Vercel → Project → Settings → Environment Variables).'
    );
  }

  cachedInstance = new Razorpay({ key_id, key_secret });
  return cachedInstance;
}
