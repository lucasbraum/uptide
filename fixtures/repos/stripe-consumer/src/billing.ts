import Stripe from 'stripe';

export const version: Stripe.LatestApiVersion = '2023-10-16';
const stripe = new Stripe('sk_test_fixture', { apiVersion: '2023-10-16' });

export async function checkout(customer: string) {
  return stripe.checkout.sessions.create({
    mode: 'subscription',
    customer,
    line_items: [{ price: 'price_fixture', quantity: 1 }],
    success_url: 'https://example.test/success',
    cancel_url: 'https://example.test/cancel',
  });
}

export async function subscription(id: string) {
  const subscription = await stripe.subscriptions.retrieve(id);
  return subscription.current_period_end;
}

export function webhook(payload: Buffer, signature: string, secret: string) {
  const event = stripe.webhooks.constructEvent(payload, signature, secret);
  if (event.type === 'customer.subscription.updated') {
    return event.data.object.current_period_end;
  }
  return null;
}
