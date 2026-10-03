import Stripe from 'stripe';

const stripe = new Stripe('sk_test_fixture', { apiVersion: '2023-10-16' });

export async function periodEnd(id: string): Promise<number> {
  const subscription = await stripe.subscriptions.retrieve(id);
  return subscription.current_period_end;
}
