import { describe, expect, it } from 'vitest';
import { accessLogSchema } from './monitoring.js';

const line = {
  requestId: '7b0c1c1e-2f6f-4a55-9d5b-0f3c0f0a9d11',
  clientIp: '203.0.113.7',
  path: '/orders',
  status: 200,
  at: '2026-01-05T10:00:00.000Z',
};

describe('accessLogSchema', () => {
  it('accepts a line from the edge proxy, IPv4 or IPv6', () => {
    expect(accessLogSchema.safeParse(line).success).toBe(true);
    expect(accessLogSchema.safeParse({ ...line, clientIp: '2001:db8::7' }).success).toBe(true);
  });

  it('reports a missing path', () => {
    const { path: _path, ...withoutPath } = line;
    const parsed = accessLogSchema.safeParse(withoutPath);
    expect(parsed.error?.issues[0]?.message).toBe('Required');
  });
});
