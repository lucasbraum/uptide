import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { run } from '../cli.js';
import { checkResult, fakeEngine, memoryIo, npmRepo } from '../test-utils.js';
import { createTelemetry } from './client.js';
import { readSettings } from './settings.js';
import type { Delivery } from './transport.js';

function setup(env: Record<string, string | undefined> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'uptide-telemetry-'));
  const path = join(dir, 'settings', 'telemetry.json');
  const sent: Delivery[] = [];
  const confirm = vi.fn(async () => false);
  const io = memoryIo({
    cwd: dir,
    env,
    inTty: true,
    outTty: true,
    errTty: true,
    confirmTelemetry: confirm,
  });
  const options = {
    path,
    version: '0.1.0',
    key: 'phc_test',
    dispatch: (value: Delivery) => {
      sent.push(value);
    },
    publicVersion: () => true,
  };
  return { dir, path, sent, confirm, io, options, client: createTelemetry(io, options) };
}

describe('consent', () => {
  it('asks once, treats anything but explicit yes as no, persists no, and never dispatches', async () => {
    const s = setup();
    await s.client.begin('list', {});
    s.client.finish(0);
    await createTelemetry(s.io, s.options).begin('list', {});
    expect(s.confirm).toHaveBeenCalledTimes(1);
    expect(readSettings(s.path)).toEqual({ consent: false });
    expect(s.sent).toEqual([]);
  });
  it('persists explicit yes with a private random identity and secret salt', async () => {
    const s = setup();
    s.confirm.mockResolvedValue(true);
    await s.client.begin('check', {});
    s.client.finish(1);
    expect(s.sent).toHaveLength(1);
    expect(statSync(s.path).mode & 0o777).toBe(0o600);
    const saved = readSettings(s.path);
    expect(saved?.consent).toBe(true);
    expect(saved?.salt).toHaveLength(64);
    expect(JSON.stringify(s.sent)).not.toContain(saved?.salt);
    await createTelemetry(s.io, s.options).begin('check', {});
    expect(s.confirm).toHaveBeenCalledTimes(1);
  });
  it.each([{ CI: 'true' }, { GITHUB_ACTIONS: 'true' }, { UPTIDE_TELEMETRY: '0' }])(
    'does not prompt in %j',
    async (env) => {
      const s = setup(env);
      await s.client.begin('check', {});
      s.client.finish(0);
      expect(s.confirm).not.toHaveBeenCalled();
      expect(s.sent).toEqual([]);
    },
  );
  it.each([{ ci: true }, { json: true }])('does not prompt with %j', async (flags) => {
    const s = setup();
    await s.client.begin('check', flags);
    expect(s.confirm).not.toHaveBeenCalled();
  });
  it('does not prompt on pipes, and requires an explicit environment opt-in in CI', async () => {
    const s = setup();
    s.io.inTty = false;
    await s.client.begin('list', {});
    expect(s.confirm).not.toHaveBeenCalled();
    s.client.control('on');
    s.io.env.CI = '1';
    await s.client.begin('check', {});
    s.client.finish(0);
    expect(s.sent).toEqual([]);
    s.io.env.UPTIDE_TELEMETRY = '1';
    await s.client.begin('check', { ci: true });
    s.client.finish(0);
    expect(s.sent).toHaveLength(1);
    s.io.env.UPTIDE_TELEMETRY = '0';
    await s.client.begin('check', {});
    s.client.finish(0);
    expect(s.sent).toHaveLength(1);
  });
  it('fails closed for corrupt state or failed preference writes', async () => {
    const s = setup({ UPTIDE_TELEMETRY: '1' });
    mkdirSync(join(s.dir, 'settings'));
    writeFileSync(s.path, '{bad');
    expect(readSettings(s.path)).toEqual({ consent: false });
    const blocked = join(s.dir, 'not-a-dir');
    writeFileSync(blocked, 'x');
    const client = createTelemetry(s.io, { ...s.options, path: join(blocked, 'settings.json') });
    await expect(client.begin('check', {})).resolves.toBeUndefined();
    expect(() => client.finish(0)).not.toThrow();
    expect(s.sent).toEqual([]);
  });
  it('off clears identifiers and the last event, and control/help commands are never tracked', async () => {
    const s = setup();
    s.client.control('on');
    await s.client.begin('list', {});
    s.client.finish(0);
    expect(s.client.control('show')).toEqual(s.sent[0]?.event);
    const original = readSettings(s.path)?.installId;
    await s.client.begin('telemetry', {});
    s.client.control('off');
    s.client.finish(0);
    expect(readSettings(s.path)).toEqual({ consent: false });
    expect(s.client.control('show')).toBeNull();
    expect(s.sent).toHaveLength(1);
    s.client.control('on');
    expect(readSettings(s.path)?.installId).not.toBe(original);
  });
  it('observes an opt-out written during a long run', async () => {
    const s = setup();
    s.client.control('on');
    await s.client.begin('check', {});
    createTelemetry(s.io, s.options).control('off');
    s.client.finish(0);
    expect(s.sent).toEqual([]);
  });
  it('has no transport without a build key; dispatch errors never escape', async () => {
    const s = setup({ UPTIDE_TELEMETRY: '1' });
    const noKey = createTelemetry(s.io, { ...s.options, key: '' });
    await noKey.begin('check', {});
    noKey.finish(0);
    expect(s.sent).toEqual([]);
    const broken = createTelemetry(s.io, {
      ...s.options,
      dispatch: () => {
        throw new Error('offline');
      },
    });
    await broken.begin('check', {});
    expect(() => broken.finish(0)).not.toThrow();
  });
});

it('wires CLI commands, help, JSON output and command metrics without source text', async () => {
  const s = setup({ UPTIDE_TELEMETRY: '1' });
  s.io.cwd = npmRepo();
  const help = await run(['--help'], s.io, fakeEngine(), s.client);
  expect(help).toBe(0);
  expect(s.sent).toEqual([]);
  expect(s.confirm).not.toHaveBeenCalled();
  for (const action of ['on', 'status', 'show', 'off'])
    expect(await run(['telemetry', action, '--json'], s.io, fakeEngine(), s.client)).toBe(0);
  expect(s.sent).toEqual([]);
  const engine = fakeEngine({
    check: async () => ({ ...checkResult({ breaking: 4 }), repo: s.io.cwd }),
  });
  expect(await run(['check', 'zod', '--json'], s.io, engine, s.client)).toBe(1);
  expect(s.sent[0]?.event.properties.command).toBe('check');
  expect(s.sent[0]?.event.properties.counts.breaking).toBeGreaterThan(0);
  expect(JSON.stringify(s.sent)).not.toContain(s.io.cwd);
  expect(readFileSync(s.path, 'utf8')).not.toContain(s.io.cwd);
});
