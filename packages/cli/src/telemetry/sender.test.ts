import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { buildEvent } from './payload.js';
import { identity } from './settings.js';

const sender = fileURLToPath(new URL('../../dist/telemetry-sender.js', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'uptide-https-test-'));
const cert = join(dir, 'cert.pem'),
  key = join(dir, 'key.pem');
beforeAll(() => {
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-keyout',
      key,
      '-out',
      cert,
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=IP:127.0.0.1,DNS:localhost',
    ],
    { stdio: 'ignore' },
  );
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
function send(url: string, override: Record<string, unknown> = {}) {
  const event = buildEvent(identity({ consent: true }), 'check', '0.1.0', {}, 5, 0, () => false);
  const child = spawn(process.execPath, [sender], {
    env: { NODE_EXTRA_CA_CERTS: cert },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (b) => {
    out += b;
  });
  child.stderr.on('data', (b) => {
    out += b;
  });
  const finished = once(child, 'exit').then(([code]) => ({ code, out }));
  child.stdin.end(JSON.stringify({ key: 'phc_synthetic', url, event, ...override }));
  return finished;
}

it('uses plain HTTPS capture, strips injected fields and does not follow redirects', async () => {
  const received: { path?: string; method?: string; body: unknown; agent?: string }[] = [];
  const server = createServer({ cert: readFileSync(cert), key: readFileSync(key) }, (req, res) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => {
      received.push({
        path: req.url,
        method: req.method,
        body: JSON.parse(data),
        agent: req.headers['user-agent'],
      });
      res.writeHead(302, { location: '/must-not-follow' }).end();
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const url = `https://127.0.0.1:${(server.address() as AddressInfo).port}/capture/`;
    const base = buildEvent(identity({ consent: true }), 'check', '0.1.0', {}, 5, 0, () => false);
    const result = await send(url, {
      event: {
        ...base,
        source: '/private/source.ts',
        properties: {
          ...base?.properties,
          $ip: '203.0.113.1',
          source: 'const secret = "source";',
          repo: '/private/repo',
        },
      },
    });
    expect(result).toEqual({ code: 0, out: '' });
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      path: '/capture/',
      method: 'POST',
      agent: undefined,
      body: {
        api_key: 'phc_synthetic',
        event: 'uptide_cli_run',
        properties: {
          $ip: null,
          $geoip_disable: true,
          $process_person_profile: false,
        },
      },
    });
    expect(JSON.stringify(received)).not.toMatch(/private|203\.0\.113|const secret/);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

it('terminates a stalled HTTPS response within the absolute deadline without errors', async () => {
  const server = createServer({ cert: readFileSync(cert), key: readFileSync(key) }, () => {});
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const started = Date.now();
    expect(
      await send(`https://127.0.0.1:${(server.address() as AddressInfo).port}/capture/`),
    ).toEqual({ code: 0, out: '' });
    expect(Date.now() - started).toBeLessThan(2000);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

it('silently drops invalid hosts, personal keys and refused connections', async () => {
  expect(await send('http://127.0.0.1/capture/')).toEqual({ code: 0, out: '' });
  expect(await send('https://127.0.0.1:1/capture/', { key: 'phx_not-a-project-key' })).toEqual({
    code: 0,
    out: '',
  });
  expect(await send('https://127.0.0.1:1/capture/')).toEqual({ code: 0, out: '' });
});
