import { createHmac } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { HASH, type Settings, UUID } from './settings.js';

export const COMMANDS = [
  'status',
  'list',
  'check',
  'plan',
  'fix',
  'verify',
  'clean',
  'pr',
  'pr-body',
  'diff',
] as const;
export type TelemetryCommand = (typeof COMMANDS)[number];
const COUNTS = [
  'packages',
  'workspaces',
  'breaking',
  'deprecated',
  'unverified',
  'failed',
  'partial',
  'sites',
  'files',
  'tests',
  'new_errors',
  'changes',
  'steps',
  'removed',
  'kept',
] as const;
const DURATIONS = [
  'total',
  'engine',
  'fetch',
  'diff',
  'usages',
  'compile',
  'runtime',
  'verification',
] as const;
export const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
export const NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
export interface Metrics {
  repo?: string;
  packages?: { name: string; versions: string[] }[];
  counts?: Partial<Record<(typeof COUNTS)[number], number>>;
  durations?: Partial<Record<(typeof DURATIONS)[number], number>>;
  verification?: 'passed' | 'failed' | 'not_run';
  cost?: number;
}
export interface Event {
  event: 'uptide_cli_run';
  properties: {
    schema_version: 1;
    distinct_id: string;
    repo_hash: string | null;
    command: TelemetryCommand;
    version: string;
    packages: { name: string; versions: string[] }[];
    counts: Record<string, number>;
    durations_ms: Record<string, number>;
    verification: 'passed' | 'failed' | 'not_run';
    cost_usd: number;
    exit_code: number;
    $ip: null;
    $geoip_disable: true;
    $process_person_profile: false;
  };
}
export type PublicVersion = (name: string, version: string) => boolean;

const numeric = (value: unknown, max = 1e9): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.min(max, value) : 0;
const numbers = (keys: readonly string[], input: unknown): Record<string, number> => {
  const source = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  return Object.fromEntries(
    keys
      .filter((key) => Object.hasOwn(source, key))
      .map((key) => [key, Math.round(numeric(source[key]))]),
  );
};

/** Reconstruct every wire field; reports, argument strings and unknown keys can never pass through. */
export function sanitizeEvent(input: unknown, publicVersion: PublicVersion): Event | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const p = (input as Event).properties;
  if (
    !p ||
    !UUID.test(p.distinct_id) ||
    !COMMANDS.includes(p.command) ||
    typeof p.version !== 'string' ||
    p.version.length > 128 ||
    !VERSION_PATTERN.test(p.version)
  )
    return undefined;
  const packages: Event['properties']['packages'] = [];
  for (const item of Array.isArray(p.packages) ? p.packages.slice(0, 100) : []) {
    if (
      !item ||
      typeof item.name !== 'string' ||
      item.name.length > 214 ||
      !NAME_PATTERN.test(item.name)
    )
      continue;
    const versions = [
      ...new Set(
        (Array.isArray(item.versions) ? item.versions : []).filter(
          (v): v is string =>
            typeof v === 'string' &&
            v.length <= 128 &&
            VERSION_PATTERN.test(v) &&
            publicVersion(item.name, v),
        ),
      ),
    ]
      .sort()
      .slice(0, 4);
    if (versions.length) packages.push({ name: item.name, versions });
  }
  return {
    event: 'uptide_cli_run',
    properties: {
      schema_version: 1,
      distinct_id: p.distinct_id,
      repo_hash: typeof p.repo_hash === 'string' && HASH.test(p.repo_hash) ? p.repo_hash : null,
      command: p.command,
      version: p.version,
      packages: packages.sort((a, b) => a.name.localeCompare(b.name)),
      counts: numbers(COUNTS, p.counts),
      durations_ms: numbers(DURATIONS, p.durations_ms),
      verification:
        p.verification === 'passed' || p.verification === 'failed' ? p.verification : 'not_run',
      cost_usd: Math.round(numeric(p.cost_usd, 1e6) * 1e6) / 1e6,
      exit_code: [0, 1, 2].includes(p.exit_code) ? p.exit_code : 2,
      $ip: null,
      $geoip_disable: true,
      $process_person_profile: false,
    },
  };
}

export function buildEvent(
  settings: Required<Settings>,
  command: TelemetryCommand,
  version: string,
  metrics: Metrics,
  ms: number,
  exit: number,
  publicVersion: PublicVersion,
): Event | undefined {
  let hash: string | null = null;
  if (metrics.repo)
    hash = createHmac('sha256', Buffer.from(settings.salt, 'hex'))
      .update(realpathSync(metrics.repo))
      .digest('hex');
  return sanitizeEvent(
    {
      properties: {
        distinct_id: settings.installId,
        repo_hash: hash,
        command,
        version,
        packages: metrics.packages ?? [],
        counts: metrics.counts ?? {},
        durations_ms: { ...metrics.durations, total: ms },
        verification: metrics.verification,
        cost_usd: metrics.cost ?? 0,
        exit_code: exit,
      },
    },
    publicVersion,
  );
}
