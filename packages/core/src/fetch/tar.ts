import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize, sep } from 'node:path';
import { gunzipSync } from 'node:zlib';

/**
 * Minimal ustar/pax reader, enough for tarballs produced by npm. Regular files and
 * directories are extracted; symlinks, hardlinks and devices are skipped because a
 * package we never execute has no legitimate need for them. The first path component
 * (`package/`) is stripped, matching what npm does on install.
 */

const BLOCK = 512;

interface Entry {
  path: string;
  type: string;
  size: number;
}

function readString(buf: Buffer, start: number, length: number): string {
  const end = buf.indexOf(0, start);
  const stop = end === -1 || end > start + length ? start + length : end;
  return buf.toString('utf8', start, stop);
}

function readNumber(buf: Buffer, start: number, length: number): number {
  const first = buf[start] ?? 0;
  if (first & 0x80) {
    // GNU base-256 encoding for sizes that do not fit in octal.
    let value = 0;
    for (let i = start + 1; i < start + length; i++) value = value * 256 + (buf[i] ?? 0);
    return value;
  }
  const text = readString(buf, start, length).trim();
  return text === '' ? 0 : Number.parseInt(text, 8);
}

function parsePax(buf: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let offset = 0;
  while (offset < buf.length) {
    const space = buf.indexOf(0x20, offset);
    if (space === -1) break;
    const length = Number.parseInt(buf.toString('utf8', offset, space), 10);
    if (!Number.isFinite(length) || length <= 0) break;
    const record = buf.toString('utf8', space + 1, offset + length - 1);
    const eq = record.indexOf('=');
    if (eq !== -1) out[record.slice(0, eq)] = record.slice(eq + 1);
    offset += length;
  }
  return out;
}

export function* readTar(tar: Buffer): Generator<Entry & { data: Buffer }> {
  let offset = 0;
  let pendingPath: string | undefined;
  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK);
    if (header.every((b) => b === 0)) break;
    const type = header[156] === 0 ? '0' : String.fromCharCode(header[156] as number);
    const size = readNumber(header, 124, 12);
    const prefix = readString(header, 345, 155);
    const name = readString(header, 0, 100);
    const dataStart = offset + BLOCK;
    const data = tar.subarray(dataStart, dataStart + size);
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;

    if (type === 'x') {
      const pax = parsePax(data);
      if (pax.path !== undefined) pendingPath = pax.path;
      continue;
    }
    if (type === 'L') {
      pendingPath = readString(data, 0, data.length);
      continue;
    }
    if (type === 'g' || type === 'K') continue;

    const path = pendingPath ?? (prefix ? `${prefix}/${name}` : name);
    pendingPath = undefined;
    yield { path, type, size, data };
  }
}

/** Drops the leading component and refuses anything that would escape `dest`. */
function safeRelativePath(entryPath: string): string | undefined {
  const parts = entryPath.split('/').filter((p) => p !== '' && p !== '.');
  parts.shift();
  if (parts.length === 0) return undefined;
  if (parts.some((p) => p === '..')) return undefined;
  const rel = normalize(parts.join('/'));
  if (rel.startsWith('..') || rel.startsWith(sep) || /^[A-Za-z]:/.test(rel)) return undefined;
  return rel;
}

export function extractTgz(tgz: Buffer, dest: string): string[] {
  const written: string[] = [];
  for (const entry of readTar(gunzipSync(tgz))) {
    const rel = safeRelativePath(entry.path);
    if (rel === undefined) continue;
    const target = join(dest, rel);
    if (entry.type === '5') {
      mkdirSync(target, { recursive: true });
    } else if (entry.type === '0' || entry.type === '7') {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, entry.data);
      written.push(rel);
    }
  }
  return written;
}
