import { describe, expect, it } from 'vitest';
import { cancelOrderSchema } from './orders.js';

describe('cancelOrderSchema', () => {
  it('accepts an order and a reason', () => {
    const parsed = cancelOrderSchema.safeParse({
      orderId: '7b0c1c1e-2f6f-4a55-9d5b-0f3c0f0a9d11',
      reason: 'ordered twice',
    });
    expect(parsed.success).toBe(true);
  });

  it('says which field is missing, in our words', () => {
    const parsed = cancelOrderSchema.safeParse({ reason: 'ordered twice' });
    expect(parsed.error?.issues.map((issue) => issue.message)).toEqual(['Order is required']);
  });
});
