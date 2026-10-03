import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/** What a repository's tests need besides the code: read from its files, never by running them. */
export interface ServiceNeeds {
  /** Test files that are integration or end-to-end by name or directory, repository-relative. */
  files: string[];
  /** `Postgres`, `Redis`: services the global setup or the service tests reach for. */
  services: string[];
  /** Where they would connect: masked URLs found in the setup, and the environment variables it reads. */
  targets: string[];
  /** Global setup files that connect to a service, relative to the configuration's directory. */
  setups: string[];
}

/** Integration and end-to-end tests by the names repositories give them. */
export const SERVICE_GLOBS = [
  '**/*.integration.test.*',
  '**/*.integration.spec.*',
  '**/*.int.test.*',
  '**/*.e2e.test.*',
  '**/*.e2e.spec.*',
  '**/integration/**',
  '**/e2e/**',
];
const SERVICE_FILE =
  /(?:\.(?:integration|int|e2e)\.(?:test|spec)\.[cm]?[jt]sx?$)|(?:(?:^|\/)(?:integration|e2e)\/.*\.(?:test|spec)\.[cm]?[jt]sx?$)/;
export const isServiceTest = (file: string): boolean => SERVICE_FILE.test(file);

const SIGNALS: [RegExp, string][] = [
  [
    /\bfrom\s+["']pg["']|require\(["']pg["']\)|\bpostgres(?:ql)?:\/\/|\bpostgres\b|DATABASE_URL/i,
    'Postgres',
  ],
  [/\bmysql2?\b|mysql:\/\//i, 'MySQL'],
  [/\bmongoose\b|\bmongodb\b/i, 'MongoDB'],
  [/\bioredis\b|\bredis:\/\/|from\s+["']redis["']|REDIS_URL/i, 'Redis'],
  [/\bamqplib\b|amqps?:\/\//i, 'RabbitMQ'],
  [/\bkafkajs\b/i, 'Kafka'],
  [/@azure\/service-bus/i, 'Azure Service Bus'],
  [/\btestcontainers\b/i, 'Docker (testcontainers)'],
];
const SKIPPED = new Set(['node_modules', 'dist', 'build', 'coverage', '.git', '.uptide']);

function read(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

/** `postgresql://user:secret@host/db` with the credentials masked. */
const mask = (url: string): string => url.replace(/\/\/[^@/\s]+@/, '//***@');

/** Global setup files a vitest or jest configuration names, resolved against its directory. */
function globalSetups(configDir: string, configText: string): string[] {
  const found = new Set<string>();
  for (const match of configText.matchAll(/globalSetup\s*:\s*(\[[^\]]*\]|["'`][^"'`]+["'`])/g))
    for (const path of (match[1] ?? '').matchAll(/["'`]([^"'`]+)["'`]/g))
      if (path[1]) found.add(path[1].replace(/^<rootDir>\//, './'));
  return [...found].filter((file) => existsSync(resolve(configDir, file)));
}

/**
 * Classifies a runner configuration and the workspaces it covers without executing anything:
 * which test files are integration or end-to-end, and whether the global setup connects to a
 * database, a cache or a queue (and so would run, and possibly reset one, even for unit tests).
 */
export function serviceNeeds(
  root: string,
  configDir: string,
  configFile: string,
  workspaces: string[],
  env: NodeJS.ProcessEnv = process.env,
): ServiceNeeds {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIPPED.has(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (isServiceTest(relative(root, path))) files.push(relative(root, path));
    }
  };
  for (const workspace of workspaces) {
    if (workspace === '.' && workspaces.length > 1) continue;
    try {
      walk(join(root, workspace));
    } catch {
      // An unreadable directory has no tests to count.
    }
  }
  const configText = read(join(configDir, configFile)) ?? '';
  const services = new Set<string>();
  const targets = new Set<string>();
  const setups: string[] = [];
  for (const setup of globalSetups(configDir, configText)) {
    const text = read(resolve(configDir, setup)) ?? '';
    const named = SIGNALS.filter(([signal]) => signal.test(text)).map(([, name]) => name);
    if (named.length === 0) continue;
    setups.push(setup);
    for (const name of named) services.add(name);
    for (const url of text.matchAll(
      /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|rediss?|amqps?):\/\/[^\s"'`]+/g,
    ))
      targets.add(mask(url[0]));
    for (const variable of text.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) {
      const name = variable[1] ?? '';
      if (!/DATABASE|POSTGRES|PG|REDIS|MONGO|MYSQL|AMQP|RABBIT|KAFKA|SERVICE_?BUS/.test(name))
        continue;
      const value = env[name];
      targets.add(value ? `${name}=${mask(value)}` : `${name} (not set)`);
    }
  }
  return {
    files: files.sort(),
    services: [...services].sort(),
    targets: [...targets].sort(),
    setups,
  };
}

/**
 * A vitest configuration that runs the repository's unit tests and nothing that reaches a
 * service: the repository's own configuration with integration and end-to-end files excluded,
 * projects that only hold such files dropped, and a global setup that connects to a service
 * removed. It imports the real configuration, so aliases, globals and plugins still apply.
 */
export function unitConfig(configFile: string, stripGlobalSetup: boolean): string {
  return `// Written by uptide for one test run; never committed.
import base from './${configFile}';

const SERVICE = ${JSON.stringify(SERVICE_GLOBS)};
const SERVICE_NAME = /(?:integration|\\.int\\.|e2e)/;
const resolved = typeof base === 'function' ? await base({ mode: 'test', command: 'serve' }) : await base;
const unit = (test) => {
  if (!test) return test;
  const { ${stripGlobalSetup ? 'globalSetup, ' : ''}...rest } = test;
  return { ...rest, exclude: [...(rest.exclude ?? ['**/node_modules/**', '**/dist/**']), ...SERVICE] };
};
const onlyServices = (project) =>
  typeof project === 'object' && project !== null && Array.isArray(project.test?.include) &&
  project.test.include.length > 0 && project.test.include.every((glob) => SERVICE_NAME.test(glob));
const top = unit(resolved.test ?? {});
export default {
  ...resolved,
  test: {
    ...top,
    ...(Array.isArray(top.projects)
      ? {
          projects: top.projects
            .filter((project) => !onlyServices(project))
            .map((project) =>
              typeof project === 'object' && project !== null && project.test
                ? { ...project, test: unit(project.test) }
                : project,
            ),
        }
      : {}),
  },
};
`;
}
