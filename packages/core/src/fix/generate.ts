import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { command } from './process.js';

export interface Generated {
  workspace: string;
  /** As typed from the workspace. */
  command: string;
  status: 'generated' | 'failed' | 'timeout';
  output?: string;
}

/**
 * Generated code the repository's own tests and types need and the checkout never holds: a
 * Prisma client. Without it, every test that imports `@prisma/client` fails before the
 * migration is even reached, and the baseline is a wall of TS2305. `prisma generate` reads
 * the schema and writes into node_modules; no database is contacted. It runs in the clone,
 * with the repository's own binary, and nothing else of the kind: this is the one generator
 * whose absence we have seen hide a verification.
 */
export async function generateClients(root: string, workspaces: string[]): Promise<Generated[]> {
  const out: Generated[] = [];
  for (const workspace of workspaces) {
    const dir = join(root, workspace);
    const schema = prismaSchema(dir);
    if (!schema) continue;
    const bin = findBin(dir, root, 'prisma');
    if (!bin) continue;
    const args = ['generate', '--schema', relative(dir, schema)];
    const result = await command(dir, bin, args, 180_000, {
      CHECKPOINT_DISABLE: '1',
      PRISMA_HIDE_UPDATE_MESSAGE: '1',
      PRISMA_GENERATE_SKIP_AUTOINSTALL: 'true',
    });
    out.push({
      workspace,
      command: `prisma ${args.join(' ')}`,
      status: result.timeout ? 'timeout' : result.code === 0 ? 'generated' : 'failed',
      ...(result.code === 0 && !result.timeout ? {} : { output: result.output.slice(-2000) }),
    });
  }
  return out;
}

/** The workspace's Prisma schema: `prisma/schema.prisma`, or the path package.json names. */
function prismaSchema(dir: string): string | undefined {
  try {
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      prisma?: { schema?: string };
    };
    if (manifest.prisma?.schema) {
      const named = join(dir, manifest.prisma.schema);
      return existsSync(named) ? named : undefined;
    }
  } catch {
    return undefined;
  }
  const conventional = join(dir, 'prisma/schema.prisma');
  return existsSync(conventional) ? conventional : undefined;
}

/** `node_modules/.bin/<name>` from the workspace up to the project root. */
function findBin(dir: string, root: string, name: string): string | undefined {
  for (let at = dir; ; at = dirname(at)) {
    const bin = join(at, 'node_modules/.bin', name);
    if (existsSync(bin)) return bin;
    if (at === root || dirname(at) === at) return undefined;
  }
}
