import Stripe from 'stripe';

export interface BillingClient {
  stripe: Stripe;
}

export function createBillingClient(secretKey: string): BillingClient {
  return {
    stripe: new Stripe(secretKey, { apiVersion: '2023-10-16' }),
  };
}

export async function chargeOrder(billing: BillingClient, orderId: string, amount: number) {
  return billing.stripe.paymentIntents.create({
    amount,
    currency: 'usd',
    metadata: { orderId },
  });
}
