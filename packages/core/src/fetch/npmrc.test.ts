import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadRegistryConfig, parseNpmrc, registryFor, tokenFor } from './npmrc.js';

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
