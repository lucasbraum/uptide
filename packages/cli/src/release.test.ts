// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these are GitHub Actions expressions, quoted as written in the workflows.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const read = (path: string): string =>
  readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');
const script = async <T>(name: string): Promise<T> =>
  (await import(new URL(`../../../scripts/${name}`, import.meta.url).href)) as T;

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  id?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
}
interface Job {
  needs?: string | string[];
  if?: string;
  permissions?: Record<string, string>;
  env?: Record<string, string>;
  steps: Step[];
}
interface Workflow {
  on: Record<string, { branches?: string[]; inputs?: Record<string, { default?: unknown }> }>;
  concurrency: { group: string; 'cancel-in-progress': boolean };
  permissions: Record<string, string>;
  jobs: Record<string, Job>;
}
const text = read('.github/workflows/release.yml');
const release = parse(text) as Workflow;
const job = (name: string): Job => release.jobs[name] as Job;
/** Where a step is in its job. */
const at = (j: Job, match: (s: Step) => boolean | undefined): number => {
  const i = j.steps.findIndex((s) => match(s));
  if (i === -1) throw new Error('step not found');
  return i;
};
const runs = (j: Job, needle: string) => at(j, (s) => s.run?.includes(needle));

describe('the Release workflow', () => {
  it('runs on every push to main, and by hand as a dry run unless told otherwise', () => {
    expect(Object.keys(release.on).sort()).toEqual(['push', 'workflow_dispatch']);
    expect(release.on.push?.branches).toEqual(['main']);
    expect(release.on.workflow_dispatch?.inputs?.dry_run?.default).toBe(true);
    expect(release.concurrency).toEqual({ group: 'release', 'cancel-in-progress': false });
    expect(release.permissions).toEqual({});
    // The manual flow it replaces is gone.
    expect(
      existsSync(new URL('../../../.github/workflows/release-latest.yml', import.meta.url)),
    ).toBe(false);
  });

  it('refuses anything but main of a public repository before reading the tree', () => {
    const plan = job('plan');
    expect(plan.steps[0]?.if).toBe(
      "${{ github.event.repository.visibility != 'public' || github.ref != 'refs/heads/main' }}",
    );
    expect(plan.steps[0]?.run).toContain('exit 1');
    expect(plan.permissions).toEqual({ contents: 'read' });
    for (const name of ['version-pr', 'publish']) expect(job(name).needs).toBe('plan');
    expect(job('github-release').needs).toEqual(['plan', 'publish']);
  });

  it('opens the Version Packages pull request with the release app, on a push with changesets', () => {
    const pr = job('version-pr');
    expect(pr.if).toBe(
      "${{ github.event_name == 'push' && needs.plan.outputs.pending == 'true' }}",
    );
    // The app's token, not GITHUB_TOKEN: a pull request opened with that triggers no CI.
    const app = pr.steps[at(pr, (s) => s.uses?.startsWith('actions/create-github-app-token@'))];
    expect(app?.with).toEqual({
      'app-id': '${{ vars.RELEASE_APP_ID }}',
      'private-key': '${{ secrets.RELEASE_APP_PRIVATE_KEY }}',
    });
    expect(pr.steps[1]?.run).toContain('[ "$SLUG" != uptide-release ]');
    const checkout = pr.steps[at(pr, (s) => s.uses?.startsWith('actions/checkout@'))];
    expect(checkout?.with?.token).toBe('${{ steps.app.outputs.token }}');
    const changesets = at(pr, (s) => s.uses?.startsWith('changesets/action@'));
    expect(pr.steps[changesets]?.with).toMatchObject({
      version: 'pnpm changeset version',
      title: 'Version Packages',
      setupGitUser: false,
      createGithubReleases: false,
    });
    expect(pr.steps[changesets]?.with).not.toHaveProperty('publish');
    expect(pr.steps[changesets]?.env?.GITHUB_TOKEN).toBe('${{ steps.app.outputs.token }}');
    // Commits are authored by the app's bot, the identity DCO exempts in its own pull request.
    const identity = runs(pr, 'git config user.email');
    expect(pr.steps[identity]?.run).toContain('${id}+${SLUG}[bot]@users.noreply.github.com');
    expect(identity).toBeLessThan(changesets);
    expect(pr.permissions).toEqual({ contents: 'read' });
  });

  it('publishes only the CLI, from one checked tarball, with provenance and its own dist-tag', () => {
    const publish = job('publish');
    expect(publish.if).toBe("${{ needs.plan.outputs.channel != '' }}");
    expect(publish.permissions).toEqual({ contents: 'read', 'id-token': 'write' });
    expect(publish.env?.UPTIDE_BUILD_CLEAN).toBe('1');
    // The tarball path is absolute: npm reads a relative `dir/file.tgz` as `owner/repo` on GitHub.
    expect(publish.steps[runs(publish, 'pnpm --filter uptide pack')]?.run).toContain(
      'echo "tarball=$(ls "$RUNNER_TEMP"/pack/uptide-*.tgz)"',
    );
    const step = publish.steps[runs(publish, 'npm publish')];
    expect(step?.run).toContain(
      'npm publish "$TARBALL" --tag "$CHANNEL" --access public --provenance',
    );
    const commands = Object.values(release.jobs).flatMap((j) => j.steps.map((s) => s.run ?? ''));
    expect(commands.join('\n')).not.toMatch(/changeset publish|pnpm --filter uptide publish/);
    expect(step?.env?.NODE_AUTH_TOKEN).toBe('${{ secrets.NPM_TOKEN }}');
    // npm trusted publishing needs npm 11.5.1+.
    expect(runs(publish, 'npm install --global npm@^11.5.1')).toBeLessThan(
      runs(publish, 'npm publish'),
    );
    // A dispatched run is a dry run unless told otherwise.
    expect(publish.env?.DRY_RUN).toBe(
      "${{ github.event_name == 'workflow_dispatch' && inputs.dry_run }}",
    );
    expect(step?.run).toContain(`if [ "$DRY_RUN" = true ]; then dry='--dry-run'; fi`);
  });

  it('checks everything before publishing: version, lint, private material, tests, smoke, stamp, tarball', () => {
    const publish = job('publish');
    const order = [
      runs(publish, 'node scripts/check-release-version.mjs'),
      at(publish, (s) => s.id === 'version'),
      runs(publish, 'pnpm lint'),
      runs(publish, 'node scripts/public-tree.mjs . --require-denylist'),
      runs(publish, 'pnpm build'),
      runs(publish, 'pnpm typecheck'),
      runs(publish, 'pnpm test'),
      runs(publish, 'pnpm smoke 22'),
      runs(publish, 'node scripts/check-build-stamp.mjs'),
      runs(publish, 'pnpm --filter uptide pack'),
      runs(publish, 'node scripts/check-pack.mjs "$TARBALL"'),
      runs(publish, 'npm publish'),
    ];
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    const version = publish.steps[at(publish, (s) => s.id === 'version')]?.run ?? '';
    expect(version).toContain("'^[0-9]+\\.[0-9]+\\.[0-9]+$'");
    expect(version).toContain('npm view "uptide@$version" version');
    for (const name of ['No private material in the repository', 'The tarball has']) {
      const step = publish.steps[at(publish, (s) => s.name?.startsWith(name))];
      expect(step?.env?.UPTIDE_PRIVATE_DENYLIST).toBe('${{ secrets.UPTIDE_PRIVATE_DENYLIST }}');
    }
  });

  it('publishes next from a throwaway snapshot: never committed, pushed, tagged or latest', () => {
    const publish = job('publish');
    const snapshot = publish.steps[runs(publish, 'pnpm changeset version --snapshot next')];
    expect(snapshot?.if).toBe("${{ needs.plan.outputs.channel == 'next' }}");
    expect(publish.steps[0]?.with?.['persist-credentials']).toBe(false);
    expect(text).not.toMatch(/git (push|commit)/);
    const version = publish.steps[at(publish, (s) => s.id === 'version')]?.run ?? '';
    expect(version).toContain("grep -Eq -- '-next\\.'");
    // Only latest is tagged and released.
    expect(job('github-release').if).toContain("needs.plan.outputs.channel == 'latest'");
  });

  it('tags the published commit and releases it with its CHANGELOG entry, after a real publish', () => {
    const gh = job('github-release');
    expect(gh.if).toBe(
      "${{ needs.plan.outputs.channel == 'latest' && !(github.event_name == 'workflow_dispatch' && inputs.dry_run) }}",
    );
    expect(gh.permissions).toEqual({ contents: 'write' });
    expect(gh.env?.RELEASE_COMMIT).toBe('${{ github.sha }}');
    const run = gh.steps.at(-1)?.run ?? '';
    expect(run).toContain('node scripts/changelog-entry.mjs "$VERSION"');
    expect(run).toContain('gh release create "v$VERSION"');
    expect(run).toContain('--target "$RELEASE_COMMIT"');
    expect(run).toContain('--notes-file');
    // Only this job can write to the repository.
    for (const name of ['plan', 'version-pr', 'publish'])
      expect(job(name).permissions?.contents).toBe('read');
  });

  it('keeps the engine out of the registry, and nothing publishes from a laptop', () => {
    const config = JSON.parse(read('.changeset/config.json'));
    expect(config.ignore).toEqual(['@uptide/core']);
    expect(config.changelog).toEqual([
      '@changesets/changelog-github',
      { repo: 'uptide-dev/uptide' },
    ]);
    expect(config.snapshot).toEqual({
      useCalculatedVersion: true,
      prereleaseTemplate: '{tag}.{datetime}',
    });
    const cli = JSON.parse(read('packages/cli/package.json'));
    expect(cli.publishConfig).toEqual({ access: 'public' });
    expect(cli.repository.url).toBe('git+https://github.com/uptide-dev/uptide.git');
    expect(JSON.parse(read('package.json')).scripts.release).not.toMatch(
      /\b(changeset|npm|pnpm)\b.*\bpublish\b/,
    );
  });
});

describe('the release plan', () => {
  type Plan = (input: {
    event: string;
    pending: boolean;
    version: string;
    published: string[];
  }) => { pending: boolean; version: string; channel: string };
  it('snapshots pending changesets to next, and publishes an unpublished version to latest', async () => {
    const { releasePlan } = await script<{ releasePlan: Plan }>('release-plan.mjs');
    const published = ['0.3.0', '0.4.0'];
    const channel = (event: string, pending: boolean, version: string) =>
      releasePlan({ event, pending, version, published }).channel;
    expect(channel('push', true, '0.4.0')).toBe('next');
    expect(channel('push', false, '0.5.0')).toBe('latest');
    expect(channel('push', false, '0.4.0')).toBe('');
    // By hand: only the committed version, whatever is pending.
    expect(channel('workflow_dispatch', true, '0.5.0')).toBe('latest');
    expect(channel('workflow_dispatch', true, '0.4.0')).toBe('');
  });
});

describe('the committed version guard', () => {
  it.each(['0.4.0', '0.4.0-next.20261004'])(
    'requires the planned version to match the checked-out manifest (%s)',
    (version) => {
      const root = mkdtempSync(join(tmpdir(), 'uptide-release-version-'));
      try {
        mkdirSync(join(root, 'scripts'));
        mkdirSync(join(root, 'packages/cli'), { recursive: true });
        const manifest = join(root, 'packages/cli/package.json');
        const contents = JSON.stringify({ name: 'uptide', version });
        writeFileSync(manifest, contents);
        const guard = join(root, 'scripts/check-release-version.mjs');
        writeFileSync(guard, read('scripts/check-release-version.mjs'));
        for (const input of [version, '0.1.0', '']) {
          const result = spawnSync(process.execPath, [guard], {
            cwd: tmpdir(),
            env: { ...process.env, VERSION: input },
            encoding: 'utf8',
          });
          expect(result.status).toBe(input === version ? 0 : 1);
          if (input !== version)
            expect(result.stderr).toContain(`packages/cli/package.json (${version})`);
          expect(readFileSync(manifest, 'utf8')).toBe(contents);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});

describe('the tarball check', () => {
  type Check = (dir: string, opts: { version?: string; terms?: string[] }) => string[];
  const unpacked = (files: Record<string, string>): string => {
    const dir = mkdtempSync(join(tmpdir(), 'uptide-pack-check-'));
    for (const [path, body] of Object.entries(files)) {
      mkdirSync(join(dir, 'package', path, '..'), { recursive: true });
      writeFileSync(join(dir, 'package', path), body);
    }
    return dir;
  };
  const manifest = (over: object = {}) =>
    JSON.stringify({
      name: 'uptide',
      version: '0.5.0',
      repository: { url: 'git+https://github.com/uptide-dev/uptide.git' },
      ...over,
    });
  const legal = { LICENSE: 'Apache', NOTICE: 'Uptide', 'THIRD-PARTY-NOTICES': 'zod: MIT' };

  it('passes a tarball with its legal assets, this repository, the version and no private material', async () => {
    const { packProblems } = await script<{ packProblems: Check }>('check-pack.mjs');
    const dir = unpacked({ ...legal, 'package.json': manifest(), 'dist/index.js': 'run()' });
    expect(packProblems(dir, { version: '0.5.0', terms: ['secret-co'] })).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it('names a missing legal file, a wrong repository or version, private material, a missing denylist', async () => {
    const { packProblems } = await script<{ packProblems: Check }>('check-pack.mjs');
    const dir = unpacked({
      LICENSE: 'Apache',
      'package.json': manifest({ repository: { url: 'git+https://github.com/someone/fork.git' } }),
      'dist/index.js': 'const client = "Secret-Co";',
    });
    expect(packProblems(dir, { version: '0.5.1', terms: ['secret-co'] })).toEqual([
      'NOTICE is missing',
      'THIRD-PARTY-NOTICES is missing',
      'the package is version 0.5.0, not 0.5.1',
      'repository.url is git+https://github.com/someone/fork.git, not git+https://github.com/uptide-dev/uptide.git',
      'dist/index.js: contains the private identifier "secret-co"',
    ]);
    expect(packProblems(dir, { version: '0.5.0' })).toContain(
      'no denylist: set UPTIDE_PRIVATE_DENYLIST',
    );
    rmSync(dir, { recursive: true, force: true });
  });

  // `pnpm pack` runs prepack, which needs the build; `turbo run test` builds first.
  const cli = new URL('../', import.meta.url).pathname;
  it.skipIf(!existsSync(join(cli, 'THIRD-PARTY-NOTICES')))('passes the real packed CLI', () => {
    const out = mkdtempSync(join(tmpdir(), 'uptide-pack-real-'));
    try {
      execFileSync('pnpm', ['pack', '--pack-destination', out], { cwd: cli, stdio: 'ignore' });
      const tarball = execFileSync('ls', [out], { encoding: 'utf8' }).trim();
      const result = spawnSync(
        process.execPath,
        [new URL('../../../scripts/check-pack.mjs', import.meta.url).pathname, join(out, tarball)],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            VERSION: JSON.parse(read('packages/cli/package.json')).version,
            UPTIDE_PRIVATE_DENYLIST: 'an-identifier-that-is-nowhere',
          },
        },
      );
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});

describe('release notes', () => {
  it('are the CHANGELOG entry of the version, up to the next one', async () => {
    const { changelogEntry } = await script<{
      changelogEntry(text: string, version: string): string | undefined;
    }>('changelog-entry.mjs');
    const changelog = '# uptide\n\n## 0.5.0\n\n### Minor Changes\n\n- one\n\n## 0.4.0\n\n- old\n';
    expect(changelogEntry(changelog, '0.5.0')).toBe('### Minor Changes\n\n- one');
    expect(changelogEntry(changelog, '0.4.0')).toBe('- old');
    expect(changelogEntry(changelog, '0.6.0')).toBeUndefined();
    // The real CHANGELOG has an entry for the committed version.
    const version = JSON.parse(read('packages/cli/package.json')).version;
    expect(changelogEntry(read('packages/cli/CHANGELOG.md'), version)).toMatch(/\S/);
  });
});
