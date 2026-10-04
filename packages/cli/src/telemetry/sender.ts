import { request } from 'node:https';
import { captureUrl } from './config.js';
import { sanitizeEvent } from './payload.js';

// An absolute process deadline also bounds stalled DNS and slow response bodies.
setTimeout(() => process.exit(0), 750);
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  input += chunk;
  if (Buffer.byteLength(input) > 32 * 1024) process.exit(0);
});
process.stdin.on('error', () => process.exit(0));
process.stdin.on('end', () => {
  try {
    const value = JSON.parse(input);
    const url = new URL(value.url);
    if (
      captureUrl(url.origin) !== url.href ||
      typeof value.key !== 'string' ||
      !/^phc_[A-Za-z0-9_-]+$/.test(value.key)
    )
      process.exit(0);
    // The parent already checked public metadata provenance; independently strip extra
    // fields here too. No reports or paths ever reach the sender.
    const event = sanitizeEvent(value.event, () => true);
    if (!event) process.exit(0);
    const body = JSON.stringify({ api_key: value.key, ...event });
    const req = request(
      url,
      {
        method: 'POST',
        agent: false,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      },
      (res) => {
        // Do not follow redirects or retry; the body is irrelevant and never logged.
        res.destroy();
        process.exit(0);
      },
    );
    req.on('error', () => process.exit(0));
    req.end(body);
  } catch {
    process.exit(0);
  }
});
