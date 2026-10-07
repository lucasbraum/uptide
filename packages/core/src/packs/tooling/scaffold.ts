import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { UptideError } from '../../errors.js';
import { minVersion } from '../../fetch/range.js';
import { type GroundTruth, type PackVerification, truthDigest } from '../contract.js';
import { packsDir } from './pack-test.js';
import { packConstant, packDir, parseRegistry, renderRegistry } from './registry-file.js';

export interface ScaffoldOptions {
  /** The uptide checkout. */
  root: string;
  package: string;
  /** Semver ranges: installed versions migrated from, target versions. */
  from: string;
  to: string;
  /** A GitHub handle, recorded as `meta.maintainer`. */
  maintainer?: string;
}

export interface ScaffoldResult {
  dir: string;
  constant: string;
  /** Repository-relative paths, written in this order. */
  files: string[];
  /** Whether the checkout's biome formatted them (it is what `pnpm lint` checks). */
  formatted: boolean;
}

const RULE = 'example-rename';

function indexFile(o: ScaffoldOptions, constant: string): string {
  const pkg = JSON.stringify(o.package).slice(1, -1).replaceAll("'", "\\'");
  return `import { definePack, replaceAtSite } from '../contract.js';

/**
 * ${o.package} ${o.from} → ${o.to}. Every rule and note says where it comes from (\`meta.sources\`),
 * has a fixture in \`fixtures/\`, and is scored against \`ground-truth.json\` by
 * \`uptide pack test ${o.package}\`. See docs/packs.md.
 */
export const ${constant} = definePack({
  meta: {
    package: '${pkg}',
    from: '${o.from}',
    to: '${o.to}',
    // The changelog or migration guide every rule below is taken from.
    sources: [{ title: '${pkg} on npm', url: 'https://www.npmjs.com/package/${o.package}' }],
    maintainer: '${o.maintainer ?? 'uptide-dev'}',
  },
  rules: [
    {
      // An example to replace: an export renamed between the two majors.
      id: '${RULE}',
      summary: 'oldName was renamed newName',
      severity: 'breaking',
      // The findings \`check\` reports for it: the type diff sees \`oldName\` removed.
      kinds: ['removed', 'renamed'],
      symbols: /^oldName$/,
      guide: 'oldName was renamed newName, with the same arguments and result.',
      rewrite: (text, finding) => replaceAtSite(text, finding, 'oldName', 'newName'),
    },
  ],
  behavior: [],
  instructions: 'Migrate only the reported site, from the compiler error and the guide above.',
});
`;
}

const BEFORE = `import { oldName } from 'PKG'; // @uptide ${RULE} at:oldName

export const value = oldName(1); // @uptide ${RULE} at:oldName
// A different name that only starts the same: left alone.
export const oldNameLabel = 'kept'; // @uptide ${RULE} keep at:oldNameLabel
`;

function testFile(o: ScaffoldOptions, constant: string): string {
  return `import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { runFixtures } from '../tooling/fixtures.js';
import { ${constant} } from './index.js';

it('${o.package.replaceAll("'", "\\'")}: every fixture rewrites and detects exactly its marked sites', () => {
  const result = runFixtures(${constant}, fileURLToPath(new URL('.', import.meta.url)));
  expect(result.cases.length).toBeGreaterThan(0);
  expect(result.unknown).toEqual([]);
  expect(result.rewriteFailures).toEqual([]);
  expect(result.falsePositives).toEqual([]);
  expect(result.falseNegatives).toEqual([]);
});
`;
}

/** Writes the files only when none of them exists; the registry is rendered again in full. */
export function scaffoldPack(options: ScaffoldOptions): ScaffoldResult {
  if (!/^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/.test(options.package))
    throw new UptideError('INVALID_GROUND_TRUTH', `not an npm package name: ${options.package}`);
  for (const [flag, range] of [
    ['--from', options.from],
    ['--to', options.to],
  ] as const)
    if (minVersion(range) === undefined)
      throw new UptideError('UNSUPPORTED_VERSION_RANGE', `${flag} ${range}: not a semver range`);
  const packs = packsDir(options.root);
  const registryFile = join(packs, 'registry.ts');
  if (!existsSync(registryFile))
    throw new UptideError(
      'NOT_UPTIDE_CHECKOUT',
      `no pack registry at ${registryFile}: run uptide pack new inside an uptide checkout`,
    );
  const dir = packDir(options.package);
  const constant = packConstant(options.package);
  const entries = parseRegistry(readFileSync(registryFile, 'utf8'));
  const home = join(packs, dir);
  if (existsSync(home) || entries.some((e) => e.dir === dir || e.name === constant))
    throw new UptideError('PACK_EXISTS', `a pack for ${options.package} already exists: ${home}`);

  const truth: GroundTruth = {
    $comment: `Public repositories at the commit before they upgraded ${options.package} from ${options.from} to ${options.to}, and every finding the pack must report there. See docs/packs.md, "Ground truth".`,
    package: options.package,
    repos: [],
  };
  const before = BEFORE.replace('PKG', options.package);
  const after = before
    .replace('import { oldName }', 'import { newName }')
    .replace('= oldName(1)', '= newName(1)');
  const files: [string, string][] = [
    [join(home, 'index.ts'), indexFile(options, constant)],
    [join(home, 'fixtures', RULE, 'before.ts'), before],
    [join(home, 'fixtures', RULE, 'after.ts'), after],
    [join(home, `${dir}.test.ts`), testFile(options, constant)],
    [join(home, 'ground-truth.json'), `${JSON.stringify(truth, null, 2)}\n`],
  ];
  for (const [file, text] of files) {
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, text);
  }
  writeFileSync(registryFile, renderRegistry([...entries, { dir, name: constant }]));
  const written = [...files.map(([file]) => file), registryFile];
  // The checkout's own formatter has the last word on layout, so `pnpm lint` passes as is.
  // Fixtures are test data it never touches: their text is the test.
  const biome = join(options.root, 'node_modules', '.bin', 'biome');
  const formattable = written.filter((file) => !file.includes(`${dir}/fixtures/`));
  const formatted =
    existsSync(biome) &&
    spawnSync(biome, ['format', '--write', ...formattable], {
      cwd: options.root,
      stdio: 'ignore',
    }).status === 0;
  // What `pack test` records for a pack with no ground-truth repository yet, tied to the
  // ground-truth file as formatted: the first run finds it current.
  const verification: PackVerification = {
    status: 'candidate',
    truth: truthDigest(readFileSync(join(home, 'ground-truth.json'), 'utf8')),
    repos: 0,
    breaking: { precision: 1, recall: 1, falsePositives: 0 },
  };
  const verificationFile = join(home, 'verification.json');
  writeFileSync(verificationFile, `${JSON.stringify(verification, null, 2)}\n`);
  written.splice(written.length - 1, 0, verificationFile);
  return {
    dir,
    constant,
    files: written.map((file) => relative(options.root, file)),
    formatted,
  };
}
