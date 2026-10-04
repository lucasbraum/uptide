import { describe, expect, it } from 'vitest';
import { type LockfileQuery, parseBun, parseNpm, parsePnpm, parseYarn } from './lockfile.js';

const root = (declared: Record<string, string>): LockfileQuery => ({
  importer: '.',
  declared: new Map(Object.entries(declared)),
});
const importer = (path: string, declared: Record<string, string>): LockfileQuery => ({
  importer: path,
  declared: new Map(Object.entries(declared)),
});

describe('lockfile parsers read the importer being checked', () => {
  it('npm v3 root, workspace with its own copy, and v1', () => {
    const v3 = JSON.stringify({
      packages: {
        '': {},
        'node_modules/axios': { version: '0.27.2' },
        'node_modules/@scope/pkg': { version: '1.2.3' },
        'packages/app/node_modules/axios': { version: '1.7.0' },
      },
    });
    expect([...parseNpm(v3, root({ axios: '^0.27', '@scope/pkg': '^1' }))]).toEqual([
      ['axios', '0.27.2'],
      ['@scope/pkg', '1.2.3'],
    ]);
    expect([
      ...parseNpm(v3, importer('packages/app', { axios: '^1', '@scope/pkg': '^1' })),
    ]).toEqual([
      ['axios', '1.7.0'],
      ['@scope/pkg', '1.2.3'],
    ]);
    const v1 = JSON.stringify({ dependencies: { zod: { version: '3.23.8' } } });
    expect([...parseNpm(v1, root({ zod: '^3' }))]).toEqual([['zod', '3.23.8']]);
  });

  it('pnpm v9: two importers with different versions of the same package', () => {
    const v9 = `lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      axios:
        specifier: ^0.27.0
        version: 0.27.2
      '@scope/pkg':
        specifier: ^1
        version: 1.2.3(react@18.0.0)
    devDependencies:
      zod:
        specifier: ^3
        version: 3.23.8

  packages/app:
    dependencies:
      axios:
        specifier: ^1
        version: 1.7.0

packages:

  axios@0.27.2:
    resolution: {integrity: sha512-x}
`;
    expect([...parsePnpm(v9, root({ axios: '', '@scope/pkg': '', zod: '' }))]).toEqual([
      ['axios', '0.27.2'],
      ['@scope/pkg', '1.2.3'],
      ['zod', '3.23.8'],
    ]);
    expect([...parsePnpm(v9, importer('packages/app', { axios: '', zod: '' }))]).toEqual([
      ['axios', '1.7.0'],
    ]);
  });

  it('pnpm v5 top-level dependencies', () => {
    const v5 = `lockfileVersion: 5.4\n\nspecifiers:\n  axios: ^0.27.0\n\ndependencies:\n  axios: 0.27.2\n  zod: 3.23.8_react@18\n`;
    expect([...parsePnpm(v5, root({ axios: '', zod: '' }))]).toEqual([
      ['axios', '0.27.2'],
      ['zod', '3.23.8'],
    ]);
  });

  it('yarn v1 and berry select the entry by the declared range', () => {
    const v1 = `# yarn lockfile v1\n\n\n"@scope/pkg@^1.0.0":\n  version "1.2.3"\n\naxios@^0.27.0, axios@~0.27.1:\n  version "0.27.2"\n\naxios@^1.0.0:\n  version "1.7.0"\n`;
    expect([...parseYarn(v1, root({ '@scope/pkg': '^1.0.0', axios: '^0.27.0' }))]).toEqual([
      ['@scope/pkg', '1.2.3'],
      ['axios', '0.27.2'],
    ]);
    expect([...parseYarn(v1, importer('packages/app', { axios: '^1.0.0' }))]).toEqual([
      ['axios', '1.7.0'],
    ]);
    const berry = `__metadata:\n  version: 8\n\n"axios@npm:^0.27.0":\n  version: 0.27.2\n\n"zod@npm:^3.0.0, zod@npm:^3.20.0":\n  version: 3.23.8\n`;
    expect([...parseYarn(berry, root({ axios: '^0.27.0', zod: '^3.20.0' }))]).toEqual([
      ['axios', '0.27.2'],
      ['zod', '3.23.8'],
    ]);
  });

  it('bun text lockfile, root and workspace copy', () => {
    const bun = `{\n  "lockfileVersion": 1,\n  "workspaces": { "": { "name": "root" }, "packages/app": { "name": "app" } },\n  "packages": {\n    "axios": ["axios@0.27.2", "", {}, "sha512-x"],\n    "app/axios": ["axios@1.7.0", "", {}, "sha512-z"],\n    "@scope/pkg": ["@scope/pkg@1.2.3", "", {}, "sha512-y"],\n  },\n}\n`;
    expect([...parseBun(bun, root({ axios: '', '@scope/pkg': '' }))]).toEqual([
      ['axios', '0.27.2'],
      ['@scope/pkg', '1.2.3'],
    ]);
    expect([...parseBun(bun, importer('packages/app', { axios: '' }))]).toEqual([
      ['axios', '1.7.0'],
    ]);
  });
});

it('selects the declared npm alias range rather than the first Yarn alias entry', () => {
  const text = `"alias@npm:actual@^1.0.0":
  version "1.2.0"

"alias@npm:actual@^2.0.0":
  version "2.3.0"
`;
  expect(
    parseYarn(text, { importer: '.', declared: new Map([['alias', 'npm:actual@^2.0.0']]) }).get(
      'alias',
    ),
  ).toBe('2.3.0');
});
