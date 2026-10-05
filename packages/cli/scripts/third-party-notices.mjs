// THIRD-PARTY-NOTICES for the bundled CLI: the notice of every third-party package whose
// code is actually inside `dist`, read from the bundler's own record of what it emitted.
//
//   node scripts/third-party-notices.mjs [package-dir] [--check] [--json]
//
// The inventory never comes from declared dependencies: `dependencies` lists what may be
// installed, which is neither what the bundler inlined (it tree-shakes, and it pulls in
// transitive packages nobody declared here) nor what is redistributed. esbuild's metafile
// names every input file that contributed bytes to an output, so that is the source.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDir = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);

/** Licenses this project accepts in the published bundle. Anything else stops the build. */
export const ALLOWED_LICENSES = [
  '0BSD',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'BlueOak-1.0.0',
  'ISC',
  'MIT',
];

export const METAFILE = 'dist/metafile-esm.json';
export const NOTICES_FILE = 'THIRD-PARTY-NOTICES';

/** `LICENSE`, `LICENCE.md`, `LICENSE-MIT`, `COPYING` — whatever the package called it. */
const LICENSE_FILE = /^(licen[sc]e|copying)([-_.].*)?$/i;
const NOTICE_FILE = /^notice([-_.].*)?$/i;

/**
 * Code a package vendors instead of depending on: it is in the bundle, but it has no
 * package.json of its own there, so nothing about the installed tree can find it.
 * An entry is proven against the bundle, not trusted: `host` must be bundled and `input`
 * must be one of the files it contributed, or the build fails as stale.
 */
export const VENDORED = [
  {
    name: 'typescript',
    // @ts-morph/common ships the TypeScript compiler as one pre-bundled file rather than
    // depending on the npm package, and the CLI inlines that file.
    host: '@ts-morph/common',
    input: 'dist/typescript.js',
    license: 'Apache-2.0',
    // The compiler states its own version; nothing else in the bundle records it.
    version: (source) => /\bvar version = "([^"]+)"/.exec(source)?.[1],
    // That one file carries Microsoft's copyright notice but not the license body. The
    // body is the same for every TypeScript release, so read it from the installed one.
    licenseFrom: 'typescript',
    licenseFile: 'LICENSE.txt',
  },
];

/** The leading `/*! ... *\/` banner of a source file, verbatim, or undefined. */
export function leadingBanner(source) {
  const match = /^\s*\/\*![\s\S]*?\*\//.exec(source);
  return match ? match[0].trim() : undefined;
}

/**
 * The directory of the installed package that owns `file`, with its manifest. Package
 * roots are children of a `node_modules` directory — scoped ones grandchildren — so the
 * walk up stops there rather than escaping into the workspace. Nested manifests that only
 * set `type` (a package's own `dist/package.json`) are skipped: a root states its name.
 */
export function packageRoot(file) {
  let dir = dirname(file);
  while (dir !== dirname(dir)) {
    if (basename(dir) === 'node_modules') return undefined;
    const manifest = join(dir, 'package.json');
    if (existsSync(manifest)) {
      const json = JSON.parse(readFileSync(manifest, 'utf8'));
      if (json.name && json.version) return { dir, manifest: json };
    }
    dir = dirname(dir);
  }
  return undefined;
}

/** The SPDX expression a manifest states, including the two shapes npm used to allow. */
export function licenseId(manifest) {
  if (typeof manifest.license === 'string') return manifest.license.trim() || undefined;
  if (typeof manifest.license?.type === 'string') return manifest.license.type.trim() || undefined;
  const legacy = (Array.isArray(manifest.licenses) ? manifest.licenses : [])
    .map((entry) => (typeof entry === 'string' ? entry : entry?.type))
    .filter(Boolean);
  if (!legacy.length) return undefined;
  return legacy.length === 1 ? legacy[0] : `(${legacy.join(' OR ')})`;
}

/**
 * Whether every way of satisfying an SPDX expression is on the allowlist for `OR`, and
 * every term for `AND`. `WITH` exceptions and nested parentheses are not understood and
 * are rejected, which is the safe direction: a human looks at it.
 */
export function isAllowed(expression, allowed = ALLOWED_LICENSES) {
  const text = String(expression ?? '').trim();
  if (!text) return false;
  const bare = /^\(([^()]*)\)$/.exec(text)?.[1] ?? text;
  if (/[()]/.test(bare)) return false;
  const terms = bare.split(/\s+(?:OR|AND)\s+/).map((term) => term.trim().replace(/\+$/, ''));
  if (terms.some((term) => !term || /\s/.test(term))) return false;
  const ok = (term) => allowed.includes(term);
  return / OR /.test(bare) ? terms.some(ok) : terms.every(ok);
}

/** The license and NOTICE files a package directory ships, in a stable order. */
export function legalFiles(dir) {
  const names = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
  return {
    licenses: names.filter((name) => LICENSE_FILE.test(name)),
    notices: names.filter((name) => NOTICE_FILE.test(name)),
  };
}

/** Every input file that contributed bytes to an output of this build. */
export function bundledInputs(metafile) {
  const inputs = new Set();
  for (const output of Object.values(metafile.outputs ?? {}))
    for (const [input, info] of Object.entries(output.inputs ?? {}))
      if ((info?.bytesInOutput ?? 0) > 0) inputs.add(input);
  return [...inputs].sort();
}

function read(dir, name) {
  return readFileSync(join(dir, name), 'utf8').replace(/\r\n/g, '\n').trimEnd();
}

function resolveInstalled(name) {
  try {
    return dirname(require.resolve(`${name}/package.json`));
  } catch {
    return undefined;
  }
}

/**
 * One notice per third-party package in the bundle, sorted, with the full text of every
 * license and NOTICE file it ships. `problems` is empty only when each one states a
 * license on the allowlist and has that license's text on disk.
 */
export function notices(metafile, { cwd = packageDir, vendored = VENDORED } = {}) {
  const problems = [];
  const found = new Map();
  const inputsByPackage = new Map();

  for (const input of bundledInputs(metafile)) {
    const file = join(cwd, input);
    if (!file.split(sep).includes('node_modules')) continue;
    const root = packageRoot(file);
    if (!root) {
      problems.push(`${input}: is bundled from node_modules but belongs to no package`);
      continue;
    }
    const { manifest } = root;
    const key = `${manifest.name}@${manifest.version}`;
    if (!inputsByPackage.has(key)) inputsByPackage.set(key, []);
    inputsByPackage.get(key).push(input);
    if (found.has(key)) continue;

    const license = licenseId(manifest);
    const { licenses, notices: noticeNames } = legalFiles(root.dir);
    if (!license) problems.push(`${key}: is bundled but states no license`);
    else if (!isAllowed(license))
      problems.push(`${key}: is bundled under "${license}", which is not on the allowlist`);
    if (!licenses.length) problems.push(`${key}: is bundled but ships no license text`);

    found.set(key, {
      name: manifest.name,
      version: manifest.version,
      license,
      texts: licenses.map((name) => ({ kind: 'license', name, text: read(root.dir, name) })),
      // Apache-2.0 section 4(d) requires a NOTICE to travel with the code unchanged.
      noticeTexts: noticeNames.map((name) => ({
        kind: 'notice',
        name,
        text: read(root.dir, name),
      })),
    });
  }

  for (const entry of vendored) {
    const hostInputs = [...inputsByPackage]
      .filter(([key]) => key.startsWith(`${entry.host}@`))
      .flatMap(([, inputs]) => inputs);
    if (!hostInputs.length) continue;
    const input = hostInputs.find((path) => path.endsWith(`/${entry.input}`));
    if (!input) {
      problems.push(
        `${entry.name}: vendored in ${entry.host}, but ${entry.input} is not in this bundle — the entry in VENDORED is stale`,
      );
      continue;
    }
    const source = readFileSync(join(cwd, input), 'utf8');
    const version = entry.version(source);
    if (!version) {
      problems.push(`${entry.name}: vendored in ${entry.host}, but its version is unreadable`);
      continue;
    }
    const banner = leadingBanner(source);
    if (!banner)
      problems.push(
        `${entry.name}: vendored in ${entry.host} with no copyright notice to carry over`,
      );
    if (!isAllowed(entry.license))
      problems.push(
        `${entry.name}: is bundled under "${entry.license}", which is not on the allowlist`,
      );
    const from = resolveInstalled(entry.licenseFrom);
    const licensePath = from && join(from, entry.licenseFile);
    if (!licensePath || !existsSync(licensePath)) {
      problems.push(
        `${entry.name}: vendored in ${entry.host}, but ${entry.licenseFrom}/${entry.licenseFile} is not installed to read its license from`,
      );
      continue;
    }
    const installed = JSON.parse(readFileSync(join(from, 'package.json'), 'utf8'));
    found.set(`${entry.name}@${version}`, {
      name: entry.name,
      version,
      license: entry.license,
      vendoredIn: `${entry.host}/${entry.input}`,
      texts: [
        ...(banner ? [{ kind: 'banner', name: entry.input, text: banner }] : []),
        {
          kind: 'license',
          name: `${entry.licenseFile} of the installed ${entry.licenseFrom}@${installed.version}`,
          text: read(from, entry.licenseFile),
        },
      ],
      noticeTexts: [],
    });
  }

  const packages = [...found.values()].sort((a, b) =>
    a.name === b.name ? a.version.localeCompare(b.version) : a.name.localeCompare(b.name),
  );
  return { packages, problems: problems.sort() };
}

const RULE = '-'.repeat(78);

/** The file, from the notices: the same input always renders the same bytes. */
export function render(packages) {
  const lines = [
    'Uptide third-party notices',
    '==========================',
    '',
    'The published `uptide` package is one bundle: the code of the packages below is',
    'inlined into its `dist`. This file lists exactly those packages, generated from the',
    "bundler's own record of every file that contributed bytes to that bundle, not from",
    'declared dependencies. Each entry carries the full license text the package ships,',
    'and any NOTICE file verbatim.',
    '',
    'Generated by packages/cli/scripts/third-party-notices.mjs. Do not edit by hand.',
    '',
    'Uptide itself is licensed under the Apache License, Version 2.0; see LICENSE and',
    'NOTICE. Nothing below changes that, and nothing in Uptide changes the terms below.',
    '',
    `Bundled packages (${packages.length}):`,
    '',
  ];
  for (const pkg of packages)
    lines.push(
      `  ${pkg.name} ${pkg.version} — ${pkg.license}${pkg.vendoredIn ? ` (vendored in ${pkg.vendoredIn})` : ''}`,
    );

  for (const pkg of packages) {
    lines.push('', RULE, `${pkg.name} ${pkg.version}`, `SPDX-License-Identifier: ${pkg.license}`);
    if (pkg.vendoredIn) lines.push(`Bundled as part of ${pkg.vendoredIn}`);
    lines.push(RULE);
    for (const { kind, name, text } of [...pkg.texts, ...pkg.noticeTexts]) {
      const heading = {
        license: `License text (${name}):`,
        notice: `NOTICE file (${name}), carried over verbatim:`,
        banner: `Copyright notice carried over verbatim from ${name}:`,
      }[kind];
      lines.push('', heading, '', text);
    }
  }
  return `${lines.join('\n')}\n`;
}

/** The notices for this package's last build, or a message saying why there are none. */
export function generate({ cwd = packageDir } = {}) {
  const metafile = join(cwd, METAFILE);
  if (!existsSync(metafile))
    return { problems: [`${METAFILE}: missing — run tsup first (it writes the metafile)`] };
  const { packages, problems } = notices(JSON.parse(readFileSync(metafile, 'utf8')), { cwd });
  if (!packages.length) problems.push(`${METAFILE}: names no third-party package in the bundle`);
  return { packages, problems, text: problems.length ? undefined : render(packages) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  // A directory may be given so a test can run this against a tree it built itself.
  const cwd = resolve(args.find((arg) => !arg.startsWith('--')) ?? packageDir);
  const { packages = [], problems, text } = generate({ cwd });
  if (args.includes('--json')) {
    console.log(
      JSON.stringify(
        { packages: packages.map((p) => `${p.name}@${p.version}`), problems },
        null,
        2,
      ),
    );
  } else {
    for (const problem of problems) console.error(`  \u2717 ${problem}`);
  }
  if (problems.length) process.exit(1);

  const target = join(cwd, NOTICES_FILE);
  const current = existsSync(target) ? readFileSync(target, 'utf8') : undefined;
  if (args.includes('--check')) {
    if (current === text) process.exit(0);
    console.error(`${NOTICES_FILE} is out of date: run pnpm build`);
    process.exit(1);
  }
  if (current !== text) writeFileSync(target, text);
  if (!args.includes('--json')) console.log(`${NOTICES_FILE}: ${packages.length} bundled packages`);
}
