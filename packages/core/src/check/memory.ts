import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { availableParallelism, freemem, platform, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { ts } from 'ts-morph';
import { readInstalled } from '../adapters/typescript/repo.js';
import { workspaceSourceMap } from '../adapters/typescript/workspace-source.js';

const MB = 1024 ** 2;
/** Available physical memory, including reclaimable cache where the OS exposes it. */
export function freeMemoryBytes(): number {
  try {
    if (platform() === 'linux') {
      const available = /^MemAvailable:\s+(\d+) kB/m.exec(readFileSync('/proc/meminfo', 'utf8'));
      let bytes = available ? Number(available[1]) * 1024 : freemem();
      for (const [limitFile, usedFile] of [
        ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory.current'],
        [
          '/sys/fs/cgroup/memory/memory.limit_in_bytes',
          '/sys/fs/cgroup/memory/memory.usage_in_bytes',
        ],
      ]) {
        try {
          const limit = Number(readFileSync(limitFile as string, 'utf8').trim());
          const used = Number(readFileSync(usedFile as string, 'utf8').trim());
          if (Number.isFinite(limit) && Number.isFinite(used))
            bytes = Math.min(bytes, Math.max(0, limit - used));
        } catch {
          /* No cgroup limit on this host. */
        }
      }
      return bytes;
    }
    if (platform() === 'darwin') {
      const percent = /memory free percentage: (\d+)%/.exec(
        execFileSync('/usr/bin/memory_pressure', ['-Q'], { encoding: 'utf8', timeout: 1000 }),
      );
      if (percent) return (totalmem() * Number(percent[1])) / 100;
    }
  } catch {
    /* Fall back to the portable, more conservative free-page count. */
  }
  return freemem();
}

/** Reserve 40% of available memory for other work; allow native/young-generation overhead
 * inside each slot too. An override can lower the heap, never bypass the memory budget. */
export function memoryPolicy(
  freeBytes = freeMemoryBytes(),
  cpus = availableParallelism(),
  requested = cpus,
  estimateMb = 1024,
  env = process.env,
): { workers: number; heapMb: number; budgetMb: number } {
  const budgetMb = Math.floor((freeBytes / MB) * 0.6);
  const workers = Math.max(1, Math.min(cpus, requested, Math.floor(budgetMb / (estimateMb * 1.4))));
  const limit = Math.max(0, Math.floor(budgetMb / workers / 1.4));
  const override = Number(env.UPTIDE_WORKER_HEAP_MB);
  return {
    workers,
    heapMb: Math.min(
      8192,
      limit,
      Number.isFinite(override) && override >= 128 ? Math.floor(override) : 8192,
    ),
    budgetMb,
  };
}

/** Estimate the reachable source/declaration graph without constructing a program or checker.
 * Include automatic ambient types and the same workspace source paths as the compiler.
 * Unrelated installed declarations and unrelated workspace sources contribute nothing. */
export function scopedMemoryEstimate(
  dir: string,
  roots?: string[],
): { heapMb: number; sourceBytes: number; declarationBytes: number; files: number } {
  const config = join(dir, 'tsconfig.json');
  const parsed = existsSync(config)
    ? ts.getParsedCommandLineOfConfigFile(
        config,
        {},
        { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} },
      )
    : undefined;
  const options: ts.CompilerOptions = parsed?.options ?? {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
  };
  const sources = workspaceSourceMap(dir, readInstalled(dir).installed);
  options.paths = { ...options.paths, ...sources.paths };
  const pending = new Set(roots ?? parsed?.fileNames ?? []);
  const cache = ts.createModuleResolutionCache(dir, (p) => p, options);
  const addType = (name: string, containing: string): void => {
    const found = ts.resolveTypeReferenceDirective(
      name,
      containing,
      options,
      ts.sys,
    ).resolvedTypeReferenceDirective;
    if (found?.resolvedFileName) pending.add(found.resolvedFileName);
  };
  for (const name of ts.getAutomaticTypeDirectiveNames(options, ts.sys))
    addType(name, join(dir, '__uptide__.ts'));
  pending.add(ts.getDefaultLibFilePath(options));
  let sourceBytes = 0;
  let declarationBytes = 0;
  for (const file of pending) {
    const text = ts.sys.readFile(file);
    if (text === undefined) continue;
    if (/\.d\.[cm]?ts$/.test(file)) declarationBytes += Buffer.byteLength(text);
    else sourceBytes += Buffer.byteLength(text);
    const info = ts.preProcessFile(text, true, true);
    const mode = ts.getImpliedNodeFormatForFile(file, undefined, ts.sys, options);
    for (const imp of info.importedFiles) {
      const found = ts.resolveModuleName(
        imp.fileName,
        file,
        options,
        ts.sys,
        cache,
        undefined,
        mode,
      ).resolvedModule;
      if (found?.resolvedFileName) pending.add(found.resolvedFileName);
    }
    for (const ref of info.referencedFiles) pending.add(resolve(dirname(file), ref.fileName));
    for (const ref of info.typeReferenceDirectives) addType(ref.fileName, file);
    for (const ref of info.libReferenceDirectives)
      pending.add(
        join(dirname(ts.getDefaultLibFilePath(options)), `lib.${ref.fileName.toLowerCase()}.d.ts`),
      );
  }
  // Calibrated against isolated scoped checks (Outline mobx-react and Documenso zod).
  // Checking application code expands more than loading declarations; each root also
  // contributes checker/overlay state. The 1.4x RSS reservation in memoryPolicy is extra.
  const heapMb = Math.ceil(
    512 +
      (sourceBytes / MB) * 150 +
      (declarationBytes / MB) * 24 +
      (roots ?? parsed?.fileNames ?? []).length * 4.5,
  );
  return { heapMb, sourceBytes, declarationBytes, files: pending.size };
}

export function estimateScopedHeapMb(dir: string, roots?: string[]): number {
  return scopedMemoryEstimate(dir, roots).heapMb;
}
