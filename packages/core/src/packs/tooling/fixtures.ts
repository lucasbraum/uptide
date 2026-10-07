import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChangeKind } from '../../domain/change.js';
import type { Finding } from '../../domain/report.js';
import { minVersion } from '../../fetch/range.js';
import { detectIn, type Pack, ruleFor } from '../contract.js';

/**
 * Fixtures: `fixtures/<case>/before.ts` and `after.ts` in the pack's directory. A site is a
 * line ending in a marker comment:
 *
 *   z.string({ required_error: 'A' }); // @uptide error-params at:z.string
 *   z.string({ errorMap: m });         // @uptide error-params keep at:z.string
 *
 * `keep` marks a site the rule must leave alone. `at:<text>` is where on the line the site
 * starts (default: the first non-blank column), `kind:` and `path:` the change `check` would
 * report there (default: the rule's first kind, and the rule id). Every marked site of a rule
 * with `rewrite` is rewritten, bottom-up, and the result must equal `after.ts` byte for byte
 * (markers included: they are comments). A rule or note with `detect` must find exactly its
 * marked lines in `before.ts`, and nothing on any other line.
 */
export interface FixtureSite {
  case: string;
  file: string;
  line: number;
  rule: string;
  keep: boolean;
  at?: string;
  kind?: ChangeKind;
  path?: string;
}

export interface FixtureResult {
  cases: string[];
  /** Per rule: detection against the markers (rules with `detect`), rewrites against `after.ts`. */
  rules: Record<string, { truePositives: number; falsePositives: number; falseNegatives: number }>;
  falsePositives: { rule: string; file: string; line: number }[];
  falseNegatives: { rule: string; file: string; line: number }[];
  /** A case whose rewritten `before.ts` differs from `after.ts`, or a rewrite that should not have applied. */
  rewriteFailures: { case: string; file: string; line?: number; message: string }[];
  /** A marker naming no rule or note of the pack. */
  unknown: { file: string; line: number; rule: string }[];
}

const MARKER = /\/\/\s*@uptide\s+([\w-]+)((?:\s+[^\s]+)*)\s*$/;

export function parseMarkers(text: string, caseName: string, file: string): FixtureSite[] {
  const sites: FixtureSite[] = [];
  text.split('\n').forEach((line, i) => {
    const match = MARKER.exec(line);
    if (!match) return;
    const site: FixtureSite = {
      case: caseName,
      file,
      line: i + 1,
      rule: match[1] as string,
      keep: false,
    };
    for (const word of (match[2] ?? '').trim().split(/\s+/).filter(Boolean)) {
      if (word === 'keep') site.keep = true;
      else if (word.startsWith('at:')) site.at = word.slice(3);
      else if (word.startsWith('kind:')) site.kind = word.slice(5) as ChangeKind;
      else if (word.startsWith('path:')) site.path = word.slice(5);
    }
    sites.push(site);
  });
  return sites;
}

/** Versions inside the pack's ranges, for the context a fixture runs under. */
export function fixtureVersions(pack: Pick<Pack, 'meta'>): { from: string; to: string } {
  const from = minVersion(pack.meta.from) ?? '0.0.0';
  const to = minVersion(pack.meta.to) ?? '0.0.0';
  return { from, to };
}

/** The finding `check` would report at a marked site. */
export function fixtureFinding(
  pack: Pick<Pack, 'meta' | 'rules'>,
  site: FixtureSite,
  text: string,
): Finding {
  const { from, to } = fixtureVersions(pack);
  const rule = pack.rules.find((r) => r.id === site.rule);
  const lineText = text.split('\n')[site.line - 1] ?? '';
  const at = site.at ? lineText.indexOf(site.at) : -1;
  const column = (at >= 0 ? at : lineText.search(/\S|$/)) + 1;
  const kind = site.kind ?? rule?.kinds[0] ?? 'signature';
  const path = site.path ?? site.at ?? site.rule;
  const severity = rule?.severity ?? 'breaking';
  return {
    change: {
      package: pack.meta.package,
      from,
      to,
      path,
      kind,
      severity,
      source: 'types',
      confidence: 1,
    },
    usage: {
      file: site.file,
      line: site.line,
      column,
      endLine: site.line,
      endColumn: column,
      symbolPath: path,
      access: 'call',
      snippet: lineText.trim(),
      via: 'direct',
    },
    severity,
    confidence: 1,
    fixability: 'mechanical',
    reason: '',
    rule: site.rule,
  };
}

export function fixtureCases(dir: string): string[] {
  const root = join(dir, 'fixtures');
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(root, e.name, 'before.ts')))
    .map((e) => e.name)
    .sort();
}

/** Every fixture case of the pack in `dir`, scored the way ground truth is. */
export function runFixtures(pack: Pack, dir: string): FixtureResult {
  const result: FixtureResult = {
    cases: [],
    rules: {},
    falsePositives: [],
    falseNegatives: [],
    rewriteFailures: [],
    unknown: [],
  };
  const tally = (rule: string) => {
    result.rules[rule] ??= { truePositives: 0, falsePositives: 0, falseNegatives: 0 };
    return result.rules[rule];
  };
  for (const rule of pack.rules) tally(rule.id);
  for (const note of pack.behavior.filter((b) => b.detect)) tally(note.id);
  const known = new Set([...pack.rules.map((r) => r.id), ...pack.behavior.map((b) => b.id)]);
  const detecting = new Set([
    ...pack.rules.filter((r) => r.detect).map((r) => r.id),
    ...pack.behavior.filter((b) => b.detect && b.reported.includes('finding')).map((b) => b.id),
  ]);
  for (const name of fixtureCases(dir)) {
    result.cases.push(name);
    const file = `fixtures/${name}/before.ts`;
    const before = readFileSync(join(dir, file), 'utf8');
    const afterPath = join(dir, 'fixtures', name, 'after.ts');
    const after = existsSync(afterPath) ? readFileSync(afterPath, 'utf8') : before;
    const sites = parseMarkers(before, name, file);
    for (const site of sites)
      if (!known.has(site.rule))
        result.unknown.push({ file: site.file, line: site.line, rule: site.rule });

    // Detection: exactly the marked lines, for every rule or note that detects.
    const found = detectIn(pack, file, before);
    for (const id of detecting) {
      const expected = new Set(sites.filter((s) => s.rule === id && !s.keep).map((s) => s.line));
      const got = new Set(found.filter((f) => f.rule === id).map((f) => f.line));
      for (const line of got) {
        if (expected.has(line)) tally(id).truePositives++;
        else {
          tally(id).falsePositives++;
          result.falsePositives.push({ rule: id, file, line });
        }
      }
      for (const line of expected)
        if (!got.has(line)) {
          tally(id).falseNegatives++;
          result.falseNegatives.push({ rule: id, file, line });
        }
    }

    // Rewrites: every marked site of a rule that rewrites, bottom-up so lines stay put.
    let text = before;
    const { from, to } = fixtureVersions(pack);
    const context = { from, to, includeDeprecated: true };
    for (const site of [...sites].sort((a, b) => b.line - a.line)) {
      const rule = pack.rules.find((r) => r.id === site.rule);
      if (!rule?.rewrite) continue;
      const finding = fixtureFinding(pack, site, text);
      if (ruleFor(pack.rules, finding)?.id !== rule.id) continue;
      const out = pack.transform(text, finding, context);
      if (site.keep) {
        if (out.applied) {
          tally(rule.id).falsePositives++;
          result.rewriteFailures.push({
            case: name,
            file,
            line: site.line,
            message: `${rule.id} rewrote a site marked keep (${out.reason})`,
          });
        }
        continue;
      }
      if (!out.applied) {
        tally(rule.id).falseNegatives++;
        result.rewriteFailures.push({
          case: name,
          file,
          line: site.line,
          message: `${rule.id} did not rewrite the site: ${out.reason}`,
        });
        continue;
      }
      if (!rule.detect) tally(rule.id).truePositives++;
      text = out.text;
    }
    if (text !== after)
      result.rewriteFailures.push({
        case: name,
        file: `fixtures/${name}/after.ts`,
        message: `the rewritten before.ts differs from after.ts:\n${firstDifference(text, after)}`,
      });
  }
  return result;
}

function firstDifference(got: string, want: string): string {
  const a = got.split('\n');
  const b = want.split('\n');
  for (let i = 0; i < Math.max(a.length, b.length); i++)
    if (a[i] !== b[i])
      return `  line ${i + 1}\n  - expected: ${b[i] ?? '(end of file)'}\n  + got:      ${a[i] ?? '(end of file)'}`;
  return '';
}

export function fixturesPass(result: FixtureResult): boolean {
  return (
    result.falsePositives.length === 0 &&
    result.falseNegatives.length === 0 &&
    result.rewriteFailures.length === 0 &&
    result.unknown.length === 0
  );
}
