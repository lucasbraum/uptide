import { createHash } from 'node:crypto';
import { css, js } from './assets.js';
import { escapeHtml } from './escape.js';

/** Shared local-report shell, styling, copy buttons and print behavior. */
export function reportDocument(title: string, body: string): string {
  const scriptHash = createHash('sha256').update(js).digest('base64');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-${scriptHash}'; connect-src 'none'; base-uri 'none'; form-action 'none'"><meta name="referrer" content="no-referrer"><title>${escapeHtml(title)}</title><style>${css}</style></head>
<body><main>${body}</main><script>${js}</script></body></html>`;
}
