import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Event } from './payload.js';

export interface Delivery {
  url: string;
  key: string;
  event: Event;
}
export const MAX_BYTES = 32 * 1024;

/** A short-lived child owns DNS/TLS and the deadline. No network handle, flush or retry
 * can keep the CLI alive. Only an allowlisted event crosses stdin; no environment secrets. */
export function dispatch(delivery: Delivery): void {
  const message = JSON.stringify(delivery);
  if (Buffer.byteLength(message) > MAX_BYTES) return;
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL('./telemetry-sender.js', import.meta.url))],
    {
      detached: true,
      windowsHide: true,
      stdio: ['pipe', 'ignore', 'ignore'],
      env: {
        ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {}),
        ...(process.env.NODE_EXTRA_CA_CERTS
          ? { NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS }
          : {}),
      },
    },
  );
  child.on('error', () => {});
  child.stdin.on('error', () => {});
  child.stdin.end(message);
  // Child stdin is a net.Socket at runtime, but child_process exposes only Writable.
  (child.stdin as typeof child.stdin & { unref?: () => void }).unref?.();
  child.unref();
}
