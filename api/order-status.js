// api/order-status.js
//
// Lets the SAME browser tab recover from "payment succeeded but the report
// never loaded" (e.g. the connection dropped right after paying, or the
// tab was suspended/discarded mid-verification). The frontend calls this
// with the order_id it remembers for the current visit and asks "was this
// actually paid?" before ever unlocking the report again — it never just
// trusts its own earlier memory of success.

import { getOrder } from '../lib/store.js';

export async function GET(request) {
  const url = new URL(request.url);
  const orderId = url.searchParams.get('order_id');

  if (!orderId) {
    return Response.json({ error: 'order_id is required' }, { status: 400 });
  }

  const order = await getOrder(orderId);
  if (!order) {
    return Response.json({ paid: false });
  }

  return Response.json({ paid: order.status === 'paid', orderId: order.orderId });
}
