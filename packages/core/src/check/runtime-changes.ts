import type { Change } from '../domain/change.js';
import type { Finding } from '../domain/report.js';
import type { Usage } from '../domain/usage.js';
import { parseVersion } from './version.js';

/**
 * Behaviour changes that leave the declarations alone: express 5 rewrote route matching and
 * dropped a few methods whose types still read the same. A small curated list, matched
 * syntactically on the files that use the package, reported as `unverified` and labeled
 * as runtime changes: the compiler and the diff cannot see them, so nobody claims certainty.
 */
interface Rule {
  pattern: RegExp;
  what: string;
}

interface Curated {
  package: string;
  /** Applies when the installed major is below `major` and the target major is at least it. */
  major: number;
  rules: Rule[];
}

export const CURATED: Curated[] = [
  {
    package: 'express',
    major: 5,
    rules: [
      { pattern: /\.del\(/, what: 'app.del() was removed; use app.delete()' },
      {
        pattern: /\breq\.param\(/,
        what: 'req.param() was removed; read req.params, req.query or req.body',
      },
      {
        pattern: /\bres\.send\(\s*\d{3}\s*[,)]/,
        what: 'res.send(status) was removed; use res.sendStatus(code) or res.status(code).send()',
      },
      {
        pattern:
          /\.(get|post|put|patch|delete|all|use|route)\(\s*['"`][^'"`]*(\*|\?|\+|\(|:[A-Za-z_$][\w$]*\?)/,
        what: 'route paths use path-to-regexp v8: `*` becomes a named splat (`/{*path}`), `?`/`+`/regex groups and optional params (`:id?`) are written as `{/:id}`',
      },
    ],
  },
];

export const RUNTIME_LABEL = 'runtime change, not visible in types';

export function runtimeChangeFindings(
  meta: { package: string; from: string; to: string },
  files: { file: string; text: string }[],
): Finding[] {
  const curated = CURATED.find((c) => c.package === meta.package);
  if (!curated) return [];
  const from = parseVersion(meta.from)?.major;
  const to = parseVersion(meta.to)?.major;
  if (from === undefined || to === undefined || from >= curated.major || to < curated.major)
    return [];
  const out: Finding[] = [];
  for (const { file, text } of files) {
    const lines = text.split('\n');
    lines.forEach((line, index) => {
      for (const rule of curated.rules) {
        if (!rule.pattern.test(line)) continue;
        const usage: Usage = {
          file,
          line: index + 1,
          column: 1,
          endLine: index + 1,
          endColumn: line.length + 1,
          symbolPath: `runtime:${meta.package}`,
          access: 'call',
          snippet: line.trim(),
          via: 'inferred',
        };
        const change: Change = {
          ...meta,
          path: `runtime:${meta.package}`,
          kind: 'signature',
          severity: 'breaking',
          source: 'types',
          confidence: 0.6,
          evidence: 'text',
          notes: `${RUNTIME_LABEL}: ${rule.what}`,
        };
        out.push({
          change,
          usage,
          severity: 'unverified',
          confidence: 0.6,
          fixability: 'assisted',
          reason: `${RUNTIME_LABEL}: ${rule.what}`,
        });
      }
    });
  }
  return out;
}
