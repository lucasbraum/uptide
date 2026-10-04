import { expect, it, vi } from 'vitest';
import { captureUrl } from './config.js';
import { buildEvent } from './payload.js';
import { identity } from './settings.js';
import { dispatch } from './transport.js';

const child = vi.hoisted(() => ({
  on: vi.fn(),
  unref: vi.fn(),
  stdin: { on: vi.fn(), end: vi.fn(), unref: vi.fn() },
}));
const spawn = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn }));

it('hands only sanitized input to a detached, unreferenced sender without inherited secrets', () => {
  spawn.mockReturnValue(child);
  vi.stubEnv('ANTHROPIC_API_KEY', 'synthetic-secret');
  vi.stubEnv('NODE_OPTIONS', '--require /secret/file');
  try {
    const event = buildEvent(identity({ consent: true }), 'list', '0.1.0', {}, 1, 0, () => false);
    if (!event) throw new Error('missing test event');
    dispatch({ url: 'https://localhost/capture/', key: 'phc_test', event });
    expect(spawn).toHaveBeenCalledWith(
      process.execPath,
      [expect.stringMatching(/telemetry-sender\.js$/)],
      expect.objectContaining({ detached: true, stdio: ['pipe', 'ignore', 'ignore'] }),
    );
    const options = spawn.mock.calls[0]?.[2];
    expect(options.env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(options.env).not.toHaveProperty('NODE_OPTIONS');
    expect(child.unref).toHaveBeenCalledOnce();
    expect(child.stdin.unref).toHaveBeenCalledOnce();
    expect(JSON.parse(child.stdin.end.mock.calls[0]?.[0]).event).toEqual(event);
  } finally {
    vi.unstubAllEnvs();
  }
});

it('allows only HTTPS origin overrides without credentials or payload-bearing URL components', () => {
  expect(captureUrl('https://eu.i.posthog.com')).toBe('https://eu.i.posthog.com/capture/');
  expect(captureUrl('https://localhost:8443')).toBe('https://localhost:8443/capture/');
  for (const host of [
    'http://localhost',
    'https://user:password@localhost',
    'https://localhost/private-path',
    'https://localhost?source=secret',
    'https://localhost#repo',
    'file:///private',
  ])
    expect(captureUrl(host)).toBeUndefined();
});
