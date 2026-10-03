import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { DefaultMessageSite } from '../types.js';

/**
 * Zod 4 words its default error messages differently, and nothing in the types says so: code
 * and tests that match the old text keep compiling and then fail or silently stop matching.
 * `rewrite` is set only where the zod 4 wording is certain whatever the schema's type; the
 * other patterns are reported for a person to decide.
 */
const DEFAULTS: { was: RegExp; rewrite?: (text: string) => string; now: string }[] = [
  {
    // zod 3: "Required". zod 4: "Invalid input: expected string, received undefined".
    was: /^Required$/,
    rewrite: () => 'received undefined',
    now: 'Invalid input: expected <type>, received undefined',
  },
  {
    was: /^Expected (\w+), received (\w+)$/,
    rewrite: (text) =>
      text.replace(/^Expected (\w+), received (\w+)$/, 'Invalid input: expected $1, received $2'),
    now: 'Invalid input: expected <type>, received <type>',
  },
  {
    was: /^Invalid (?:email|uuid|url|datetime|date|cuid|ulid|ip)$/,
    now: 'a reworded format message',
  },
  { was: /^Invalid enum value\b/, now: 'Invalid option: expected one of …' },
  { was: /^Invalid literal value\b/, now: 'Invalid input: expected …' },
  {
    was: /^(?:String|Array) must contain (?:at least|at most|exactly) \d+ /,
    now: 'Too small / Too big: expected …',
  },
  { was: /^Number must be (?:greater|less) than\b/, now: 'Too small / Too big: expected number …' },
  { was: /^Unrecognized key\(s\) in object\b/, now: 'Unrecognized key: …' },
];

const SOURCE = /\.[cm]?[jt]sx?$/;
const TEST = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const SKIPPED = new Set(['node_modules', 'dist', 'build', 'coverage', '.git', '.uptide']);
const LITERAL = /(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/g;
const BUILDER =
  /\bz\.\w+\(|\.(?:min|max|length|nonempty|email|url|uuid|regex|refine|superRefine|int|positive)\(/;
const MATCHER =
  /\b(?:expect\b|toBe|toEqual|toStrictEqual|toContain|toMatch|toThrow|stringContaining|stringMatching|toHaveProperty|toHaveBeenCalledWith|objectContaining)\b/;

/**
 * String literals that are a zod 3 default message, where depending on one is plausible: in a
 * file that imports zod, or inside an assertion of a test file. "Required" as a form label in
 * a component is neither, and is not reported.
 */
export function defaultMessageSites(root: string, workspaces: string[]): DefaultMessageSite[] {
  const found: DefaultMessageSite[] = [];
  const visit = (path: string): void => {
    const text = readFileSync(path, 'utf8');
    const usesZod = /from\s+["']zod(?:\/[\w./-]+)?["']|require\(\s*["']zod["']\s*\)/.test(text);
    const isTest = TEST.test(path);
    if (!usesZod && !isTest) return;
    text.split('\n').forEach((line, i) => {
      if (!usesZod && !MATCHER.test(line)) return;
      // A message a schema sets itself is custom, not a default someone depends on.
      if (/\b(?:message|error|required_error|invalid_type_error)\s*:/.test(line)) return;
      // The same goes for a message passed to a schema builder: `z.string().min(1, "Required")`.
      if (!MATCHER.test(line) && BUILDER.test(line)) return;
      for (const match of line.matchAll(LITERAL)) {
        const value = match[2] ?? '';
        const known = DEFAULTS.find((d) => d.was.test(value));
        if (!known) continue;
        const replacement = known.rewrite?.(value);
        found.push({
          file: relative(root, path),
          line: i + 1,
          text: value,
          now: known.now,
          ...(replacement !== undefined ? { replacement } : {}),
        });
      }
    });
  };
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIPPED.has(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (SOURCE.test(entry.name)) visit(path);
    }
  };
  for (const workspace of workspaces) {
    if (workspace === '.' && workspaces.length > 1) continue;
    try {
      walk(join(root, workspace));
    } catch {
      // An unreadable directory has nothing to report.
    }
  }
  return found.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}
