import { definePack, type PackRule } from '../contract.js';
import {
  bareCoveragePatternSites,
  jestDomRegistrationSites,
  matcherAugmentationSites,
  removedEntrypointSites,
  replaceEntrypoint,
} from './detect.js';

/**
 * vitest >=4 <5 → >=5 <6, with the @vitest/* packages that are released with it. Taken from
 * the official "Migrating to Vitest 5.0" guide (`docs/guide/migration/index.md` of
 * vitest-dev/vitest, read 2026-10-10) and the 5.0.0 release notes (`meta.sources`). What the
 * compiler rejects is `breaking`; what compiles and runs differently (mock history, test
 * names, timers, report locations) is a behavior note, listed for review. Vitest ships no
 * codemod for this major.
 */

const rules: PackRule[] = [
  {
    id: 'bench-api',
    summary:
      '`bench` is no longer exported from "vitest": it is a fixture of `test()`, run with `await bench(name, fn).run()`',
    severity: 'breaking',
    kinds: ['removed', 'type', 'signature', 'narrowed'],
    symbols: /^(?:bench|Bench\w*)(?:[#.].*)?$/,
    guide:
      'The benchmarking API was rewritten. Replace the module-level `bench(name, fn, options)` with a regular `test(name, async ({ bench }) => { await bench(name, fn, options).run(); })`; `bench.skip`, `bench.only` and `bench.todo` become `test.skip`, `test.only` and `test.todo` on the surrounding test. The `benchmark.reporters`, `benchmark.outputFile`, `benchmark.compare` and `benchmark.outputJson` options and the `--compare` and `--outputJson` flags are removed: use `test.reporters` (`--reporter=json --outputFile=<path>`) and the per-bench `writeResult` option with `bench.from()`. The bench function must be `async`. Keep the measured function and its options as they are.',
  },
  {
    id: 'matcher-types',
    summary:
      'custom matchers declared on the global `jest.Matchers`, or on a one-parameter `Assertion<T>` or `Matchers<R>`, no longer type: augment `Matchers<R, T>` of "vitest"',
    severity: 'breaking',
    kinds: ['type', 'signature', 'required', 'cause'],
    symbols: /^(?:TS(?:2339|2551|2428|2320|2314)|cause:.*|Assertion|Matchers|jest\.Matchers)$/,
    message: /(?:Assertion<|Matchers<|All declarations of '(?:Assertion|Matchers)')/,
    guide:
      'Vitest 5 gives `Assertion` and `Matchers` a leading return-type parameter (`Assertion<R extends void | Promise<void>, T>`) and no longer reads matchers declared on the global `jest.Matchers`. Declare each custom matcher once, with `declare module "vitest" { interface Matchers<R, T> { toBeFoo(expected: string): R; } }` (the unused `T` needs an eslint-disable, not a different shape); a matcher that always returns a promise returns `Promise<void>` instead of `Promise<R>`. Many TS2339 and TS2551 errors on `expect(...).toBeFoo` have this one cause: fix the declaration once, then recompile. A library that supports Jest and Vitest declares `jest.Matchers` and `vitest.Matchers` separately. Never cast `expect` to `any` to silence the errors.',
    detect: (text) => matcherAugmentationSites(text),
  },
  {
    id: 'jest-dom-matchers',
    summary:
      '`import "@testing-library/jest-dom/vitest"` registers matchers whose types no longer reach `expect`: register them with `expect.extend` and augment `Matchers<R, T>`',
    severity: 'breaking',
    kinds: [],
    symbols: /$^/,
    guide:
      'jest-dom declares its matchers on the one-parameter `Assertion<T>` (or on the global `jest.Matchers`), which Vitest 5 neither merges nor reads, so `toBeInTheDocument()` and the rest stop typing even though they still register at runtime. Until a jest-dom release types against Vitest 5, replace the import with one shared setup module: `import * as matchers from "@testing-library/jest-dom/matchers"; import type { TestingLibraryMatchers } from "@testing-library/jest-dom/matchers"; declare module "vitest" { interface Matchers<R, T> extends TestingLibraryMatchers<any, R> {} } expect.extend(matchers);`. Check first whether the jest-dom version in use already ships Vitest 5 types, and keep the import if it does.',
    detect: (text) => jestDomRegistrationSites(text),
  },
  {
    id: 'removed-entrypoints',
    summary:
      '`vitest/coverage` and `vitest/reporters` are `vitest/node`, `vitest/environments` and `vitest/snapshot` are `vitest/runtime`',
    severity: 'breaking',
    kinds: [],
    symbols: /$^/,
    guide:
      'The entry points deprecated in 4.1 are gone: `vitest/coverage` and `vitest/reporters` are `vitest/node`; `vitest/environments` and `vitest/snapshot` are `vitest/runtime`. Change the import path and nothing else.',
    detect: (text) => removedEntrypointSites(text),
    rewrite: (text, finding) => replaceEntrypoint(text, finding),
  },
  {
    id: 'removed-entrypoints-manual',
    summary:
      '`vitest/runners`, `vitest/suite`, `vitest/mocker` and `vitest/internal/module-runner` are removed with no drop-in path',
    severity: 'breaking',
    kinds: [],
    symbols: /$^/,
    guide:
      '`vitest/runners` is `TestRunner` from "vitest"; `vitest/suite` is the static methods of `TestRunner` (`TestRunner.getCurrentTest()`); `vitest/mocker` is the `@vitest/mocker` package (add it to devDependencies); `vitest/internal/module-runner` has no replacement. Move the code that used the entry point to the replacement; the import path alone does not do it.',
    detect: (text) => removedEntrypointSites(text, true),
  },
  {
    id: 'sequential-removed',
    summary:
      '`test.sequential`, `describe.sequential` and the `sequential` option are removed: use `concurrent: false`',
    severity: 'breaking',
    kinds: ['removed', 'type', 'signature'],
    symbols: /(?:^|[#.])sequential$/,
    guide:
      '`test.sequential(name, fn)` is `test(name, { concurrent: false }, fn)`, `describe.sequential(name, fn)` is `describe(name, { concurrent: false }, fn)`, and the option object `{ sequential: true }` is `{ concurrent: false }`. Keep the options already there (a timeout, `retry`) in the same object.',
  },
];

export const vitestPack = definePack({
  meta: {
    package: 'vitest',
    from: '>=4 <5',
    to: '>=5 <6',
    sources: [
      { title: 'Migrating to Vitest 5.0', url: 'https://vitest.dev/guide/migration' },
      {
        title: 'Vitest 5.0.0 release notes',
        url: 'https://github.com/vitest-dev/vitest/releases/tag/v5.0.0',
      },
      {
        title: 'Vitest benchmarking guide',
        url: 'https://vitest.dev/guide/benchmarking',
      },
      {
        title: 'Extending matchers',
        url: 'https://vitest.dev/guide/extending-matchers',
      },
    ],
    maintainer: '@uptide-dev',
  },
  defaultTarget: '5.0.3',
  rules,
  behavior: [
    {
      id: 'coverage-patterns',
      summary:
        '`coverage.include` and `coverage.exclude` match the path relative to the project root, without picomatch `contains`; a bare directory such as `src/config` matches only what is inside it, so write `src/config/**` and check the reported file set',
      reported: ['finding', 'decision'],
      severity: 'breaking',
      detect: (text) => bareCoveragePatternSites(text),
    },
    {
      id: 'clear-mocks-default',
      summary:
        '`clearMocks` defaults to `true`: mock call history is cleared before every test, so assertions on calls recorded in a setup file, at module level or in `beforeAll` see nothing; set `clearMocks: false` to keep the old behavior, and drop an explicit `clearMocks: true`',
      reported: ['decision', 'test-follow-up'],
    },
    {
      id: 'test-name-pattern',
      summary:
        '`testNamePattern` (`-t`) matches the full name joined with " > ", as the reporter prints it: a pattern spanning two segments (`-t "math adds"`) becomes `-t "math > adds"`',
      reported: ['decision'],
    },
    {
      id: 'inline-projects-extend',
      summary:
        'inline projects in `test.projects` inherit the root config (`extends` defaults to `true`; arrays such as `setupFiles` are merged, not replaced) and share the Vite server (`sharedViteServer`): set `extends: false` or `sharedViteServer: false` to keep the old behavior; a referenced config that defines `projects` now provides nested projects',
      reported: ['decision'],
    },
    {
      id: 'hoisted-calls-top-level',
      summary:
        '`vi.mock`, `vi.unmock` and `vi.hoisted` inside a function, block, `describe` or `test` throw instead of warning: move them to the top level of the file (`vi.doMock` and `vi.doUnmock` are not hoisted and may stay)',
      reported: ['decision'],
    },
    {
      id: 'mock-behavior',
      summary:
        "class mocks keep the implementation's prototype methods (`vi.fn(Dog)` instances now have `speak` and pass `instanceof Dog`), and in browser mode an automocked module returns `undefined` instead of calling the real implementation (use `{ spy: true }` or a factory)",
      reported: ['decision'],
    },
    {
      id: 'assertion-timing',
      summary:
        'an un-awaited `resolves`, `rejects` or `toMatchFileSnapshot` assertion fails the test, `expect.poll` rejects when it times out (raise `timeout` if it needs longer), and `toThrow("")` matches any message (use `/^$/` for an empty one)',
      reported: ['decision', 'test-follow-up'],
    },
    {
      id: 'pretty-format-output',
      summary:
        "values are inspected with `pretty-format`, not `loupe`: a `$id` in `test.each` or `test.for` titles is no longer quoted (`case a1`, not `case 'a1'`), and snapshots or assertions that capture inspected output may need updating",
      reported: ['decision', 'test-follow-up'],
    },
    {
      id: 'fake-timers-temporal',
      summary:
        '`vi.useFakeTimers()` and `vi.setSystemTime()` also mock `Temporal` when it exists on the global object: add `Temporal` to `fakeTimers.toNotFake` to keep it native',
      reported: ['decision'],
    },
    {
      id: 'artifact-locations',
      summary:
        'reports and artifacts move under `.vitest/` (blob, html, attachments, failure screenshots), and the `json` and `junit` reporters write a file instead of stdout; a CI step that reads the old path or pipes `--reporter=json` needs the new path or `stdout: true`; the html reporter option `outputFile` is `outputDir`',
      reported: ['decision'],
    },
    {
      id: 'config-resolution',
      summary:
        'config files are no longer looked up in parent directories (pass `--config` and `--dir`), `browser.api` is replaced by the top-level `api`, `coverage.thresholds.perFile` is no longer inherited by glob thresholds, and worker and pool ids (`VITEST_WORKER_ID`, `VITEST_POOL_ID`) start at 1',
      reported: ['decision'],
    },
    {
      id: 'browser-mode',
      summary:
        'browser locators match text exactly by default (`browser.locators.exact`), `toHaveTextContent` compares for equality and its partial and regular-expression form is `toMatchTextContent`, commands receive a `SerializedLocator` instead of a selector string, `toMatchScreenshot` needs its own `screenshotDirectory`, and `render` of `vitest-browser-vue` and `vitest-browser-svelte` returns a promise',
      reported: ['decision', 'test-follow-up'],
    },
    {
      id: 'environment-requirements',
      summary:
        'Vitest 5 needs Node.js 22.12 or newer and Vite 6.4 or newer; `vite` is a peer dependency, so Yarn needs `yarn add -D vite`; Vitest UI needs the token in the URL it prints; `@vitest/runner` and `@vitest/ws-client` are deprecated, `@vitest/expect` is bundled into `vitest` (use `expect`, `expect.extend` and `chai` from "vitest"), and `@vitest/browser-webdriverio` moved to vitest-community',
      reported: ['decision'],
    },
    {
      id: 'node-api',
      summary:
        '`resolveConfig` from "vitest/node" returns the resolved Vite config (the Vitest config is its `test` property), `populateGlobal` returns property descriptors in `originals`, the `Vitest` instance `mode` is always `test`, and `TestModule` diagnostics expose `concurrencyId` next to a 1-based `workerId`',
      reported: ['decision'],
    },
  ],
  instructions:
    'Migrate only the reported site to Vitest 5, from the compiler error and the guide above. Keep every assertion, mock, timeout and test name as it is. Never cast `expect` to `any`, add `// @ts-expect-error`, or delete a test to make it compile. If the site needs a decision the guide leaves open (which jest-dom version to rely on, whether a coverage pattern should keep matching a directory, whether a test relied on the old mock history), say so instead of choosing.',
});
