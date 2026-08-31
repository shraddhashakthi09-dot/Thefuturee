// lib/cashfree.js
//
// Shared Cashfree config + a small fetch wrapper. Cashfree's Secret Key
// must only ever exist on the server — never import this file from
// anything that runs in the browser.

const API_VERSION = '2023-08-01';

function getEnv() {
  const env = (process.env.CASHFREE_ENVIRONMENT || 'sandbox').toLowerCase();
  return env === 'production' ? 'production' : 'sandbox';
}

function getBaseUrl() {
  return getEnv() === 'production'
    ? 'https://api.cashfree.com/pg'
    : 'https://sandbox.cashfree.com/pg';
}

function getCreds() {
  const clientId = process.env.CASHFREE_APP_ID;
  const clientSecret = process.env.CASHFREE_SECRET_KEY;

  if (!clientId || !clientSecret) {
    throw new Error(
      'Cashfree is not configured. Set CASHFREE_APP_ID and CASHFREE_SECRET_KEY ' +
      'as environment variables (Vercel → Project → Settings → Environment Variables).'
    );
  }
  return { clientId, clientSecret };
}

// Small wrapper around Cashfree's REST API. No SDK dependency needed —
// every call here is a plain authenticated fetch, which keeps the backend
// lighter and avoids depending on a Node SDK's exact method names.
export async function cfFetch(path, { method = 'GET', body } = {}) {
  const { clientId, clientSecret } = getCreds();

  const resp = await fetch(getBaseUrl() + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'x-client-id': clientId,
      'x-client-secret': clientSecret,
      'x-api-version': API_VERSION,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await resp.json().catch(() => ({}));

  if (!resp.ok) {
    const err = new Error(
      (data && (data.message || data.type)) || `Cashfree API error (${resp.status})`
    );
    err.status = resp.status;
    err.data = data;
    throw err;
  }

  return data;
}

// Tells the browser which Cashfree JS SDK mode to initialize. Not secret —
// it just has to match whichever account (sandbox or live) the order was
// actually created against.
export function getEnvironment() {
  return getEnv();
}

// Cashfree verifies webhook signatures using the same Client Secret used
// for API auth — unlike some gateways, there is no separate, self-invented
// webhook secret to generate and configure.
export function getWebhookSecret() {
  return getCreds().clientSecret;
}
