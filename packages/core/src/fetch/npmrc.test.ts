import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { authHeaders, loadRegistryConfig, parseNpmrc, registryFor, tokenFor } from './npmrc.js';

describe('parseNpmrc', () => {
  it('reads registry, scoped registries and tokens, ignoring the rest', () => {
    const parsed = parseNpmrc(
      [
        '# comment',
        'registry=https://npm.example.com/',
        '@acme:registry=https://npm.acme.dev',
        // biome-ignore lint/suspicious/noTemplateCurlyInString: npm's own ${VAR} syntax
        '//npm.acme.dev/:_authToken=${ACME_TOKEN}',
        'save-exact=true',
      ].join('\n'),
      { ACME_TOKEN: 'secret' },
    );
    expect(parsed).toEqual({
      registry: 'https://npm.example.com',
      scoped: { '@acme': 'https://npm.acme.dev' },
      tokens: { 'npm.acme.dev/': 'secret' },
    });
  });
});

describe('loadRegistryConfig', () => {
  it('layers user, project and environment', () => {
    const home = mkdtempSync(join(tmpdir(), 'uptide-npmrc-'));
    const cwd = mkdtempSync(join(tmpdir(), 'uptide-npmrc-'));
    writeFileSync(
      join(home, '.npmrc'),
      'registry=https://user.example\n@a:registry=https://a.user\n',
    );
    writeFileSync(join(cwd, '.npmrc'), 'registry=https://project.example\n');
    const config = loadRegistryConfig({
      cwd,
      env: {
        NPM_CONFIG_USERCONFIG: join(home, '.npmrc'),
        'npm_config_@b:registry': 'https://b.env/',
      },
    });
    expect(config.registry).toBe('https://project.example');
    expect(registryFor('@a/x', config)).toBe('https://a.user');
    expect(registryFor('@b/x', config)).toBe('https://b.env');
    expect(registryFor('plain', config)).toBe('https://project.example');
  });

  it('falls back to the public registry', () => {
    const config = loadRegistryConfig({
      cwd: mkdtempSync(join(tmpdir(), 'u-')),
      env: { NPM_CONFIG_USERCONFIG: '/nonexistent' },
    });
    expect(config.registry).toBe('https://registry.npmjs.org');
  });
});

describe('tokenFor', () => {
  it('matches the longest prefix', () => {
    const config = {
      registry: '',
      scoped: {},
      tokens: { 'npm.example.com/': 'short', 'npm.example.com/private/': 'long' },
    };
    expect(tokenFor('https://npm.example.com/private/pkg/-/pkg-1.0.0.tgz', config)).toBe('long');
    expect(tokenFor('https://npm.example.com/pkg', config)).toBe('short');
    expect(tokenFor('https://other.example.com/pkg', config)).toBeUndefined();
  });
});

it('matches npm INI quoting, comments, escapes, and environment substitution', () => {
  const config = parseNpmrc(
    [
      'registry="https://quoted.example/"',
      '@example:registry=https://scoped.example/ ; comment',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal npm environment placeholder
      '//scoped.example/:_authToken="${SYNTHETIC_TOKEN}"',
      '//other.example/:_authToken=escaped\\#token # comment',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal npm environment placeholder
      '//unset.example/:_authToken=${UNSET}',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal npm environment placeholder
      '//optional.example/:_authToken=${UNSET?}',
    ].join('\n'),
    { SYNTHETIC_TOKEN: 'fixture-value' },
  );
  expect(config.registry).toBe('https://quoted.example');
  expect(config.scoped).toEqual({ '@example': 'https://scoped.example' });
  expect(config.tokens).toEqual({
    'scoped.example/': 'fixture-value',
    'other.example/': 'escaped#token',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal npm environment placeholder
    'unset.example/': '${UNSET}',
    'optional.example/': '',
  });
});

it('finds workspace root configuration and respects lower/upper environment overrides', () => {
  const root = mkdtempSync(join(tmpdir(), 'uptide-npmrc-workspace-'));
  mkdirSync(join(root, 'packages/app'), { recursive: true });
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n - packages/*\n');
  writeFileSync(join(root, 'packages/app/package.json'), '{}');
  writeFileSync(
    join(root, '.npmrc'),
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal npm environment placeholder
    '@example:registry=https://project.example\n//project.example/:_authToken=${SYNTHETIC_TOKEN}\n',
  );
  writeFileSync(
    join(root, 'user.npmrc'),
    'registry=https://user.example\n@example:registry=https://user-scope.example\n',
  );
  writeFileSync(join(root, 'global.npmrc'), '@global:registry=https://global.example\n');
  const config = loadRegistryConfig({
    cwd: join(root, 'packages/app'),
    env: {
      npm_config_userconfig: join(root, 'user.npmrc'),
      NPM_CONFIG_GLOBALCONFIG: join(root, 'global.npmrc'),
      NPM_CONFIG_REGISTRY: 'https://env.example/',
      SYNTHETIC_TOKEN: 'fixture-project-token',
    },
  });
  expect(config.registry).toBe('https://env.example');
  expect(registryFor('@example/pkg', config)).toBe('https://project.example');
  expect(registryFor('@global/pkg', config)).toBe('https://global.example');
  expect(tokenFor('https://project.example/pkg', config)).toBe('fixture-project-token');
  expect(tokenFor('https://project.example.evil/pkg', config)).toBeUndefined();
  rmSync(root, { recursive: true, force: true });
});

it('does not send path-scoped tokens to sibling paths or other hosts', () => {
  const config = { registry: '', scoped: {}, tokens: { 'npm.example/private/': 'fixture-value' } };
  expect(tokenFor('https://npm.example/private-other/pkg', config)).toBeUndefined();
  expect(tokenFor('https://other.example/private/pkg', config)).toBeUndefined();
  expect(tokenFor('https://npm.example/private/pkg', config)).toBe('fixture-value');
});

it('selects the most specific auth scope, including legacy basic authentication', () => {
  const parsed = parseNpmrc(
    '//registry.example/:_authToken=root-token\n//registry.example/team/:username=fixture-user\n//registry.example/team/:_password=cGFzcw==\n',
  );
  const config = { registry: '', scoped: {}, tokens: {}, ...parsed };
  expect(authHeaders('https://registry.example/public', config)).toEqual({
    authorization: 'Bearer root-token',
  });
  expect(authHeaders('https://registry.example/team/pkg', config)).toEqual({
    authorization: `Basic ${Buffer.from('fixture-user:pass').toString('base64')}`,
  });
  expect(authHeaders('https://other.example/team/pkg', config)).toEqual({});
});

it('keeps a nested standalone project separate from an enclosing workspace', () => {
  const root = mkdtempSync(join(tmpdir(), 'uptide-npmrc-nested-'));
  mkdirSync(join(root, 'fixtures/project'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }));
  writeFileSync(join(root, '.npmrc'), 'registry=https://outer.example\n');
  writeFileSync(join(root, 'fixtures/project/package.json'), '{}');
  writeFileSync(join(root, 'fixtures/project/.npmrc'), 'registry=https://inner.example\n');
  const config = loadRegistryConfig({
    cwd: join(root, 'fixtures/project'),
    env: { npm_config_userconfig: '/nonexistent', npm_config_globalconfig: '/nonexistent' },
  });
  expect(config.registry).toBe('https://inner.example');
  rmSync(root, { recursive: true, force: true });
});
