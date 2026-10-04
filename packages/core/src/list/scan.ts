import { readdirSync, readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import { defaultSkip, directoryRules, type IgnoreRule, ignoredBy } from './ignore.js';
import { type ImportUsage, parseSource, type SourceJob, sourceCandidate } from './source.js';

export type { ImportUsage } from './source.js';

import { scanConfig, type TaskCommands } from './config.js';
import { isConfig } from './evidence.js';

export interface ScanStats {
  sourceMs: number;
  configMs: number;
  visitedFiles: number;
  sourceFiles: number;
  configFiles: number;
  assetFiles: number;
  parsedFiles?: number;
  workers?: number;
  skipped?: Record<string, { files: number; directories: number }>;
}
/** Syntax only: no project, type checker, module resolution, or execution. Counts direct
 * calls/new/JSX and value/type references through imported bindings; indirect aliases and reflection are not followed. */
export async function scanImports(
  root: string,
  names: string[],
  workspaces: string[],
  configs?: string[],
  evidence?: Map<string, string[]>,
  stats?: ScanStats,
  tasks?: TaskCommands[],
  concurrency?: number,
): Promise<Map<string, ImportUsage>> {
  const start = performance.now();
  const counts: ScanStats = {
    sourceMs: 0,
    configMs: 0,
    visitedFiles: 0,
    sourceFiles: 0,
    configFiles: 0,
    assetFiles: 0,
    parsedFiles: 0,
    workers: 0,
    skipped: {},
  };
  const result = new Map<string, ImportUsage>();
  const jobs: SourceJob[] = [];
  const skip = (reason: string, directory: boolean): void => {
    const skipped = counts.skipped as NonNullable<ScanStats['skipped']>;
    const count = skipped[reason] ?? { files: 0, directories: 0 };
    skipped[reason] = count;
    count[directory ? 'directories' : 'files']++;
  };
  const wanted = new Set(names);
  const packageOf = (specifier: string): string | undefined => {
    const name = specifier.startsWith('@')
      ? specifier.split('/').slice(0, 2).join('/')
      : specifier.split('/')[0];
    return name && wanted.has(name) ? name : undefined;
  };
  const walk = (dir: string, inherited: IgnoreRule[] = []): void => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    const started = performance.now();
    const rules = [
      ...inherited,
      ...directoryRules(
        dir,
        entries.filter((e) => e.isFile()).map((e) => e.name),
      ),
    ];
    counts.configMs += performance.now() - started;
    for (const entry of entries) {
      const path = join(dir, entry.name);
      const directory = entry.isDirectory();
      if (!directory) counts.visitedFiles++;
      const reason = entry.isSymbolicLink()
        ? 'symbolic links'
        : (defaultSkip(entry.name) ?? ignoredBy(path, directory, rules));
      if (reason) {
        skip(reason, directory);
        continue;
      }
      if (directory) {
        walk(path, rules);
        continue;
      }
      if (!entry.isFile()) {
        skip('non-regular files', false);
        continue;
      }
      const file = relative(root, path).replaceAll('\\', '/');
      if (isConfig(file)) {
        const started = performance.now();
        configs?.push(scanConfig(file, readFileSync(path, 'utf8'), names, evidence, tasks));
        counts.configFiles++;
        counts.configMs += performance.now() - started;
        continue;
      }
      if (/\.(?:scss|sass|less|css|html?)$/i.test(entry.name)) {
        counts.assetFiles++;
        const text = readFileSync(path, 'utf8');
        if (!names.some((name) => text.includes(name))) {
          skip('no dependency text', false);
          continue;
        }
        const add = (specifier: string, reason: string): void => {
          const clean = specifier.replace(/^~/, '').replace(/^(?:\.\.?\/|\/)*node_modules\//, '');
          const name = packageOf(clean);
          if (name) {
            const reasons = evidence?.get(name) ?? [];
            if (!reasons.includes(reason)) reasons.push(reason);
            evidence?.set(name, reasons);
          }
        };
        if (/\.html?$/i.test(entry.name)) {
          const html = text.replace(/<!--[\s\S]*?-->/g, '');
          for (const tag of html.matchAll(/<(script|link)\b[^>]*>/gi)) {
            const attr = tag[1]?.toLowerCase() === 'script' ? 'src' : 'href';
            const value = tag[0].match(
              new RegExp(`\\s${attr}\\s*=\\s*(?:"([^"<>]*)"|'([^'<>]*)'|([^\\s>]+))`, 'i'),
            );
            const url = value?.[1] ?? value?.[2] ?? value?.[3];
            if (url && /^(?:\.\.?\/|\/)*node_modules\//.test(url))
              add(url, 'referenced by HTML assets');
          }
        } else {
          const styles = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
          for (const rule of styles.matchAll(/@(import|use|forward)\s+([^;\n]+)/gi)) {
            const specifiers = (rule[2] ?? '').matchAll(
              /(?:^|,)\s*(?:\([^)]*\)\s*)?(?:url\(\s*(?:"([^"]+)"|'([^']+)'|([^\s)"']+))\s*\)|"([^"]+)"|'([^']+)')/g,
            );
            for (const value of specifiers) {
              add(value.slice(1).find(Boolean) ?? '', 'referenced by stylesheet imports');
              if (rule[1]?.toLowerCase() !== 'import') break;
            }
          }
        }
        continue;
      }
      if (!/\.[cm]?[jt]sx?$/.test(entry.name) || /\.d\.[cm]?ts$/.test(entry.name)) continue;
      counts.sourceFiles++;
      const workspace =
        [...workspaces]
          .sort((a, b) => b.length - a.length)
          .find((w) => w !== '.' && file.startsWith(`${w}/`)) ?? '.';
      const text = readFileSync(path, 'utf8');
      const gate = sourceCandidate(text, names);
      if (gate) {
        skip(gate === 'text' ? 'no dependency text' : 'no dependency imports (lexer)', false);
        continue;
      }
      jobs.push({ file, text, workspace });
    }
  };
  walk(resolve(root));
  counts.parsedFiles = jobs.length;
  const cpus = Math.max(1, Math.min(4, availableParallelism()));
  const workerCount =
    concurrency ??
    (jobs.length >= 32 && jobs.reduce((n, job) => n + job.text.length, 0) >= 8_000_000 ? cpus : 0);
  const merge = (entries: [string, ImportUsage][]): void => {
    for (const [name, found] of entries) {
      const value = result.get(name) ?? {
        files: [],
        callSites: 0,
        references: 0,
        symbols: {},
        workspaces: [],
      };
      value.files.push(...found.files);
      value.callSites += found.callSites;
      value.references += found.references;
      for (const [symbol, count] of Object.entries(found.symbols))
        value.symbols[symbol] = (value.symbols[symbol] ?? 0) + count;
      value.workspaces = [...new Set([...value.workspaces, ...found.workspaces])].sort();
      result.set(name, value);
    }
  };
  if (workerCount > 1 && jobs.length > 1) {
    const size = Math.min(workerCount, jobs.length);
    counts.workers = size;
    const batches: SourceJob[][] = Array.from({ length: size }, () => []);
    // Round-robin balances large and small sources while deterministic merging preserves output.
    jobs.forEach((job, i) => {
      batches[i % size]?.push(job);
    });
    const results = await Promise.all(batches.map((batch) => runSourceWorker(batch, names)));
    for (const batch of results) for (const entries of batch) merge(entries);
  } else for (const job of jobs) merge([...parseSource(job, names)]);
  for (const value of result.values()) value.files.sort();
  counts.sourceMs = performance.now() - start - counts.configMs;
  if (stats) Object.assign(stats, counts);
  return result;
}

async function runSourceWorker(
  jobs: SourceJob[],
  names: string[],
): Promise<[string, ImportUsage][][]> {
  const fromSource = import.meta.url.endsWith('.ts');
  const url = new URL(fromSource ? './list-worker.ts' : './list-worker.js', import.meta.url);
  return new Promise((resolve, reject) => {
    const entry = fromSource
      ? `import('tsx/esm/api').then(({ tsImport }) => tsImport(${JSON.stringify(url.href)}, ${JSON.stringify(import.meta.url)}));`
      : url;
    const worker = new Worker(entry, {
      workerData: { jobs, names },
      eval: fromSource,
      execArgv: [],
    });
    let settled = false;
    worker.once('message', (result) => {
      settled = true;
      void worker.terminate().then(() => resolve(result));
    });
    worker.once('error', (error) => {
      settled = true;
      void worker.terminate().then(() => reject(error));
    });
    worker.once('exit', (code) => {
      if (!settled) reject(new Error(`source worker exited with ${code}`));
    });
  });
}
