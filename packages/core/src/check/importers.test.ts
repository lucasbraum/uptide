import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { importedByText } from './importers.js';

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'uptide-importers-'));
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(join(root, file, '..'), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  return root;
}

describe('importedByText', () => {
  it('finds static, require and dynamic imports of the candidates, with or without a subpath', () => {
    const root = repo({
      'src/a.ts': 'import Stripe from \'stripe\';\nimport { z } from "zod/v4";\n',
      'src/b.cjs': "const s = require('stripe');\nconst p = import('pino');\n",
      'src/c.tsx': "import type { Foo } from '@scope/pkg';\nexport {};\n",
      'src/d.ts': "import { notStripe } from 'stripe-ish';\n",
    });
    expect(importedByText(root, '.', ['stripe', 'zod', 'pino', '@scope/pkg', 'left-pad'])).toEqual([
      '@scope/pkg',
      'pino',
      'stripe',
      'zod',
    ]);
    // `stripe-ish` is another package; nothing but `stripe` would claim it.
    expect(importedByText(root, '.', ['stripe-ish'])).toEqual(['stripe-ish']);
  });

  it('reads only the workspace, never nested workspaces, node_modules, build output or declarations', () => {
    const root = repo({
      'scripts/root.ts': "import 'left-pad';\n",
      'packages/app/src/index.ts': "import 'stripe';\n",
      'node_modules/x/index.js': "require('zod');\n",
      'dist/out.js': "require('pino');\n",
      'types/env.d.ts': "import 'axios';\n",
    });
    const names = ['left-pad', 'stripe', 'zod', 'pino', 'axios'];
    expect(importedByText(root, '.', names, ['.', 'packages/app'])).toEqual(['left-pad']);
    expect(importedByText(root, 'packages/app', names, ['.', 'packages/app'])).toEqual(['stripe']);
    expect(importedByText(root, '.', [])).toEqual([]);
  });
});
