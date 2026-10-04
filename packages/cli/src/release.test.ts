import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string): string =>
  readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');
const workflow = read('.github/workflows/release.yml');
const latest = read('.github/workflows/release-latest.yml');
const publishLines = (text: string): string[] =>
  text.split('\n').filter((line) => /^\s+run: .*\bpublish\b/.test(line));

describe('release pipeline', () => {
  it('runs only when triggered by hand', () => {
    const triggers = workflow.slice(workflow.indexOf('\non:'), workflow.indexOf('\nconcurrency:'));
    expect(triggers).toContain('workflow_dispatch:');
    expect(triggers).not.toMatch(/\n {2}(push|pull_request|schedule|release):/);
  });

  it('publishes only the CLI, under next, with provenance when the repository is public', () => {
    const publishes = publishLines(workflow);
    expect(publishes).toHaveLength(2);
    for (const line of publishes) {
      expect(line).toContain('pnpm --filter uptide publish');
      expect(line).toContain('--tag next');
    }
    expect(workflow).not.toMatch(/run:.*changeset publish/);
    expect(workflow).toContain('id-token: write');
    // One flag, set by the workflow from the repository's visibility: npm refuses
    // provenance from a private repository, and a public one must not publish without it.
    expect(workflow).toMatch(
      /UPTIDE_PROVENANCE: \$\{\{ github\.event\.repository\.visibility == 'public' \}\}/,
    );
    expect(workflow).toMatch(/NPM_CONFIG_PROVENANCE: \$\{\{ env\.UPTIDE_PROVENANCE \}\}/);
    expect(workflow).not.toMatch(/NPM_CONFIG_PROVENANCE: '?(true|false)/);
    expect(workflow).not.toContain('pnpm changeset version');
  });

  it('tests the tarball before publishing it', () => {
    expect(workflow.indexOf('pnpm smoke')).toBeGreaterThan(0);
    expect(workflow.indexOf('pnpm smoke')).toBeLessThan(workflow.indexOf('publish --tag next'));
  });

  it('keeps the engine out of the registry', () => {
    const config = JSON.parse(read('.changeset/config.json'));
    expect(config.ignore).toEqual(['@uptide/core']);
    expect(config.access).toBe('public');
    const cli = JSON.parse(read('packages/cli/package.json'));
    // Provenance is the workflows' flag: a manifest setting would override it either way.
    expect(cli.publishConfig).toEqual({ access: 'public' });
    expect(cli.repository.url).toBe('git+https://github.com/lucasbraum/uptide.git');
    // Nothing publishes from a laptop: the root script only points at the workflow.
    expect(JSON.parse(read('package.json')).scripts.release).not.toMatch(
      /\b(changeset|npm|pnpm)\b.*\bpublish\b/,
    );
  });

  describe('latest', () => {
    it('runs only by hand, requires a version and defaults to a dry run', () => {
      const triggers = latest.slice(latest.indexOf('\non:'), latest.indexOf('\nconcurrency:'));
      expect(triggers).toContain('workflow_dispatch:');
      expect(triggers).not.toMatch(/\n {2}(push|pull_request|schedule|release):/);
      expect(triggers).toMatch(/version:[\s\S]*?required: true/);
      expect(triggers).not.toContain('default: 0.3.0');
      expect(triggers).toMatch(/dry_run:[\s\S]*?default: true/);
    });

    it('refuses a private repository, another branch, a prerelease or a published version', () => {
      const guard = latest.slice(latest.indexOf('steps:'), latest.indexOf('actions/checkout'));
      expect(guard).toContain("github.event.repository.visibility != 'public'");
      expect(guard).toContain("github.ref != 'refs/heads/main'");
      expect(guard).toContain("'^[0-9]+\\.[0-9]+\\.[0-9]+$'");
      expect(latest).toContain('npm view "uptide@$VERSION" version');
    });

    it('publishes only the CLI, under latest, with provenance, after the smoke test', () => {
      const publishes = publishLines(latest);
      expect(publishes).toHaveLength(2);
      for (const line of publishes) {
        expect(line).toContain('pnpm --filter uptide publish');
        expect(line).toContain('--tag latest');
      }
      expect(publishes.filter((line) => line.includes('--dry-run'))).toHaveLength(1);
      expect(latest).not.toMatch(/run:.*changeset publish/);
      expect(latest).toContain('id-token: write');
      expect(latest).toContain("NPM_CONFIG_PROVENANCE: 'true'");
      expect(latest.indexOf('pnpm smoke')).toBeGreaterThan(0);
      expect(latest.indexOf('pnpm smoke')).toBeLessThan(latest.indexOf('publish --tag latest'));
      expect(latest).toContain("UPTIDE_BUILD_CLEAN: '1'");
      expect(latest).toContain('node scripts/check-build-stamp.mjs');
    });
  });
});

for (const [channel, text] of [
  ['latest', latest],
  ['next', workflow],
] as const) {
  it(`${channel} checks the committed version before install or build, without rewriting it`, () => {
    const guard = text.indexOf('run: node scripts/check-release-version.mjs');
    expect(guard).toBeGreaterThan(text.indexOf('uses: actions/checkout@v4'));
    expect(guard).toBeLessThan(text.indexOf('uses: pnpm/action-setup@v4'));
    expect(text).toMatch(/VERSION: \$\{\{ inputs\.version \}\}/);
    expect(text).toMatch(/version:[\s\S]*?required: true/);
    expect(text).not.toMatch(/npm pkg set|changeset version/);
  });
}

it.each(['0.4.0', '0.4.0-next.20261004'])(
  'requires the typed version to match the checked-out manifest (%s)',
  (version) => {
    const root = mkdtempSync(join(tmpdir(), 'uptide-release-version-'));
    try {
      mkdirSync(join(root, 'scripts'));
      mkdirSync(join(root, 'packages/cli'), { recursive: true });
      const manifest = join(root, 'packages/cli/package.json');
      const contents = JSON.stringify({ name: 'uptide', version });
      writeFileSync(manifest, contents);
      const script = join(root, 'scripts/check-release-version.mjs');
      writeFileSync(script, read('scripts/check-release-version.mjs'));
      for (const input of [version, '0.1.0', '']) {
        const result = spawnSync(process.execPath, [script], {
          cwd: tmpdir(),
          env: { ...process.env, VERSION: input },
          encoding: 'utf8',
        });
        expect(result.status).toBe(input === version ? 0 : 1);
        if (input !== version) {
          expect(result.stderr).toContain(`packages/cli/package.json (${version})`);
          expect(result.stderr).toContain('Merge the version PR first');
        }
        expect(readFileSync(manifest, 'utf8')).toBe(contents);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
