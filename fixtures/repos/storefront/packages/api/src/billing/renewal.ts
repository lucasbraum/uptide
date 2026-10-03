import type Stripe from 'stripe';
import type { BillingClient } from './client.js';

export interface Renewal {
  startedAt: Date;
  renewsAt: Date;
}

/** The billing period a customer is in, as the account page shows it. */
export function renewalOf(subscription: Stripe.Subscription): Renewal {
  return {
    startedAt: new Date(subscription.current_period_start * 1000),
    renewsAt: new Date(subscription.current_period_end * 1000),
  };
}

export async function nextRenewal(billing: BillingClient, subscriptionId: string): Promise<Date> {
  const subscription = await billing.stripe.subscriptions.retrieve(subscriptionId);
  return renewalOf(subscription).renewsAt;
}
