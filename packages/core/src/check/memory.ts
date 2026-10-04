import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { availableParallelism, freemem, platform, totalmem } from 'node:os';
import { dirname, join } from 'node:path';

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

/** Conservative preflight estimate, not a guarantee: two compiler programs plus source
 * expansion and dependency types. Never follows symlinks or traverses installed packages. */
export function estimateWorkspaceMb(dir: string, dependencies: number): number {
  let bytes = 0;
  const skip = new Set([
    'node_modules',
    '.git',
    '.next',
    '.yarn',
    '.turbo',
    'dist',
    'build',
    'coverage',
  ]);
  const walk = (at: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      if (skip.has(entry.name) || entry.isSymbolicLink()) continue;
      const path = join(at, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.[cm]?[jt]sx?$/.test(entry.name)) bytes += statSync(path).size;
    }
  };
  walk(dir);
  return Math.ceil(512 + (bytes / MB) * 150 + dependencies * 10);
}

/** Declaration volume bounds the estimate even for a small workspace importing a large
 * SDK graph. Roughly 18x syntax/type expansion per compiler program, with two programs.
 * Filesystem scan only; no compiler and no symlink traversal. */
export function estimateDeclarationHeapMb(root: string): number {
  let dir = root;
  while (!existsSync(join(dir, 'node_modules')) && dirname(dir) !== dir) dir = dirname(dir);
  const modules = join(dir, 'node_modules');
  if (!existsSync(modules)) return 0;
  let bytes = 0;
  const walk = (at: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || entry.name === '.cache' || entry.name === '.bin') continue;
      const path = join(at, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.d\.[cm]?ts$/.test(entry.name)) bytes += statSync(path).size;
    }
  };
  walk(modules);
  return Math.ceil(512 + (bytes / MB) * 36);
}
