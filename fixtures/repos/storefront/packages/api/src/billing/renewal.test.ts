import type Stripe from 'stripe';
import { describe, expect, it } from 'vitest';
import { renewalOf } from './renewal.js';

describe('renewalOf', () => {
  it('reads the current billing period of a subscription', () => {
    const subscription = {
      id: 'sub_1',
      current_period_start: 1_700_000_000,
      current_period_end: 1_702_592_000,
    } as Stripe.Subscription;
    expect(renewalOf(subscription)).toEqual({
      startedAt: new Date('2023-11-14T22:13:20.000Z'),
      renewsAt: new Date('2023-12-14T22:13:20.000Z'),
    });
  });
});
