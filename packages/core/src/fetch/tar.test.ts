import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeTgz } from '../test-utils/tar-writer.js';
import { extractTgz } from './tar.js';

describe('extractTgz', () => {
  it('strips the leading package/ component and writes files', () => {
    const dest = mkdtempSync(join(tmpdir(), 'uptide-tar-'));
    const tgz = writeTgz([
      { path: 'package/', type: '5' },
      { path: 'package/package.json', content: '{"name":"x"}' },
      { path: 'package/dist/index.d.ts', content: 'export declare const a: number;' },
    ]);
    const written = extractTgz(tgz, dest);
    expect(written.sort()).toEqual(['dist/index.d.ts', 'package.json']);
    expect(readFileSync(join(dest, 'dist/index.d.ts'), 'utf8')).toBe(
      'export declare const a: number;',
    );
  });

  it('handles pax long names', () => {
    const dest = mkdtempSync(join(tmpdir(), 'uptide-tar-'));
    const long = `package/${'deeply/'.repeat(20)}file.d.ts`;
    expect(long.length).toBeGreaterThan(100);
    extractTgz(writeTgz([{ path: long, content: 'x' }]), dest);
    expect(readFileSync(join(dest, long.slice('package/'.length)), 'utf8')).toBe('x');
  });

  it('refuses path traversal and skips symlinks', () => {
    const dest = mkdtempSync(join(tmpdir(), 'uptide-tar-'));
    const written = extractTgz(
      writeTgz([
        { path: 'package/../../evil.txt', content: 'no' },
        { path: 'package/link', type: '2' },
        { path: 'package/ok.txt', content: 'yes' },
      ]),
      dest,
    );
    expect(written).toEqual(['ok.txt']);
    expect(existsSync(join(dest, '..', 'evil.txt'))).toBe(false);
    expect(existsSync(join(dest, 'link'))).toBe(false);
  });
});
