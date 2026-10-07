/**
 * packs/queue.json: the next packages worth a pack, ranked by what app developers migrate
 * by hand.
 *
 *   pnpm packs:queue [--size=25]
 *
 * score = direct-use repositories × log2(1 + breaking type changes), × 0.9 with a partial
 * official codemod. Weekly downloads only break ties.
 *
 * 1. Direct use. A package counts once for each repository that declares it in a
 *    package.json (dependencies, devDependencies or optionalDependencies): the repositories
 *    of fixtures/corpus.json and the pinned public applications of packs-queue-sample.ts.
 *    Total npm downloads put what everything pulls in transitively on top (undici,
 *    google-auth-library); a declaration is someone choosing the package and upgrading it.
 * 2. One entry per upgrade. Packages that move together are merged and named after their
 *    hub: the links `list` draws (src/list/groups.ts: an exact pin both move together, a peer
 *    the latest version needs moved, a scope family), plus `@types/x` with `x` as `list`
 *    pairs them, a facade with what it re-exports (react-router-dom with react-router), and
 *    packages released in lockstep (react and react-dom, next and eslint-config-next). Two
 *    rules are narrower than `list`'s, which groups one repository's upgrade: a scope family
 *    links only members released in lockstep (`@tanstack/react-query` and
 *    `@tanstack/react-table` upgrade on their own), and a peer link attaches only a plugin to
 *    its host (eslint-plugin-x to eslint; react-router keeps its own entry and says it needs
 *    react moved).
 * 3. How much to migrate. `to` is the hub's latest major, `from` the major most sample
 *    repositories behind it declare. Fewer than three repositories behind: left out, the
 *    migration has happened. The breaking changes between the two type surfaces (the diff
 *    `check` runs) are counted, up to MAX_BREAKING; fewer than MIN_BREAKING: left out, the
 *    major changes too little for a pack (clsx 2, chalk 6). A package without types enters
 *    only when GUIDES records API changes from its migration guide or changelog, marked "not
 *    measured". A guide listing breaks the types cannot show (CSS, configuration, runtime)
 *    scores on max(distinct type changes, items listed), marked "type diff understates".
 *    A change repeated across many exports counts once (distinctBreaking). date-fns counts
 *    its main entry only (MAIN_ENTRY_ONLY).
 * 4. Codemods. A package whose official codemod covers the breaking changes end to end is
 *    left out; one whose codemod covers part of them says so and counts 0.9: the codemod
 *    leaves the manual work a pack does, and a pack can run it as one of its rules.
 * 5. Out: packages with a pack already (and what moves with them), anything declared in
 *    fewer than three sample repositories, and NOT_A_PACK below.
 *
 * Status: `verified` or `candidate` from the pack registry when a pack covers the upgrade;
 * `in-progress` is kept from the existing file (someone said so in an issue); else `todo`.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { type Change, diffPackage, packStatus, registeredPacks } from '@uptide/core';
import type { Manifest } from '../packages/core/src/list/evidence.js';
import { dependencyGroups } from '../packages/core/src/list/groups.js';
import type { ListedDependency } from '../packages/core/src/list/list.js';
import { declaredIn, manifestsOf, SAMPLE } from './packs-queue-sample.js';

const REGISTRY = 'https://registry.npmjs.org';
/** Declared in fewer sample repositories than this, a package is not ranked. */
const MIN_REPOS = 3;

/** Declared everywhere, but no API a pack would migrate. */
const NOT_A_PACK: Record<string, string> = {
  typescript:
    'the compiler every pack verifies with: its upgrades change compiler options and checks, not calls',
  '@types/node': 'the types of Node itself: the upgrade is the runtime, not a package',
};

/**
 * Official codemods for the upgrade `to` names, from each project's own migration guide.
 * `all`: the codemod covers every breaking change, so a pack adds nothing (left out).
 * `some`: it covers part of them, and the rest is migrated by hand (PARTIAL_CODEMOD).
 */
const CODEMODS: Record<string, { to: number; url: string; covers: 'all' | 'some'; note: string }> =
  {
    next: {
      to: 16,
      url: 'https://nextjs.org/docs/app/guides/upgrading/version-16',
      covers: 'some',
      note: '`@next/codemod upgrade` moves config, middleware to proxy and stabilized APIs; async request APIs and caching changes are reviewed by hand',
    },
    react: {
      to: 19,
      url: 'https://react.dev/blog/2024/04/25/react-19-upgrade-guide',
      covers: 'some',
      note: '`react/19/migration-recipe` and `types-react-codemod preset-19` cover render, string refs, act and removed types; the guide lists the rest as manual',
    },
    tailwindcss: {
      to: 4,
      url: 'https://tailwindcss.com/docs/upgrade-guide',
      covers: 'some',
      note: '`@tailwindcss/upgrade` converts config to CSS and renames utilities; custom plugins and changed defaults are manual',
    },
    eslint: {
      to: 10,
      url: 'https://eslint.org/docs/latest/use/migrate-to-10.0.0',
      covers: 'some',
      note: '`@eslint/migrate-config` converts .eslintrc to a flat config; removed APIs, rules and plugin compatibility are manual',
    },
    express: {
      to: 5,
      url: 'https://expressjs.com/en/guide/migrating-5',
      covers: 'some',
      note: 'the `@expressjs/v5-migration-recipe` codemods cover removed method signatures; path syntax, promise handling and changed request properties are manual',
    },
  };

/** What a partial codemod leaves: the manual work a pack does (and a pack can run it as a rule). */
const PARTIAL_CODEMOD = 0.9;
/** Fewer measured breaking type changes than this, a major is not worth a pack. */
const MIN_BREAKING = 10;
/**
 * Counted up to this many breaking changes (log2 = 14): beyond it a major rewrites the whole
 * surface either way, and the bound lets the ranking stop diffing once nothing left can place.
 */
const MAX_BREAKING = 16_383;

/**
 * Official migration guides (or changelogs, where a package has none), and the breaking
 * changes each lists for the upgrade to `to`, one entry per item the guide names. They
 * count where the type diff cannot:
 * - a break the types do not show (CSS, configuration, runtime behavior): the entry is
 *   scored on max(distinct type changes, items listed) and marked "type diff understates";
 * - a package no diff measures (no types at `from`, or a diff failure: i18next and
 *   type-fest, a diff bug): it enters only when its guide lists API changes, scored on
 *   max(MIN_BREAKING, items listed), and marked "not measured".
 * `counted` says which of the guide's sections were counted (scripts' count: every heading in
 * them with no heading under it, instructions like "How to update" aside). An empty list
 * records that the guide or changelog was read and lists no API change (the major is a Node
 * version, a CLI or configuration). Not measured and not here: left out.
 */
const GUIDES: Record<string, { to: number; url: string; counted?: string; breaking: string[] }> = {
  tailwindcss: {
    to: 4,
    url: 'https://tailwindcss.com/docs/upgrade-guide',
    counted: '"Changes from v3", every item but browser requirements',
    breaking: [
      'Removed @tailwind directives',
      'Removed deprecated utilities',
      'Updated shadow, radius, and blur scales',
      'Renamed outline utility',
      'Default ring width change',
      'Space-between selector',
      'Divide selector',
      'Using variants with gradients',
      'Container configuration',
      'Default border color',
      'Default ring width and color',
      'New default placeholder color',
      'Buttons use the default cursor',
      'Dialog margins removed',
      'Hidden attribute takes priority',
      'Using a prefix',
      'The important modifier',
      'Adding custom utilities',
      'Variant stacking order',
      'Variables in arbitrary values',
      'Arbitrary values in grid and object-position utilities',
      'Hover styles on mobile',
      'Transitioning outline-color',
      'Resetting Transforms',
      'Transitions',
      'Disabling core plugins',
      'Using the theme() function',
      'Using a JavaScript config file',
      'Theme values in JavaScript',
      'Using @apply with Vue, Svelte, or CSS modules',
      'Using Sass, Less, and Stylus',
    ],
  },
  express: {
    to: 5,
    url: 'https://expressjs.com/en/guide/migrating-5',
    counted: '"Removed methods and properties" and "Changed"',
    breaking: [
      'app.del()',
      'app.param(fn)',
      'Pluralized method names',
      'Leading colon (:) in the name for app.param(name, fn)',
      'req.param(name)',
      'res.json(obj, status)',
      'res.jsonp(obj, status)',
      'res.redirect(url, status)',
      "res.redirect('back') and res.location('back')",
      'res.send(body, status)',
      'res.send(status)',
      'res.sendfile()',
      'res.sendFile() options',
      'express.static() options',
      'router.param(fn)',
      'express.static.mime',
      'MIME type changes',
      'express:router debug logs',
      'Path route matching syntax',
      'Rejected promises handled from middleware and handlers',
      'express.urlencoded',
      'express.static dotfiles',
      'router.param() with an array of names',
      'app.listen',
      'app.router',
      'req.body',
      'req.host',
      'req.params',
      'req.query',
      'res.clearCookie',
      'res.status',
      'res.vary',
    ],
  },
  next: {
    to: 16,
    url: 'https://nextjs.org/docs/app/guides/upgrading/version-16',
    counted: 'the sections marked "(Breaking change)" and "Removals"',
    breaking: [
      'Async Request APIs',
      'Async parameters for icon, and open-graph Image',
      'Async `id` parameter for `sitemap`',
      'Local Images with Query Strings',
      '`minimumCacheTTL` Default',
      '`imageSizes` Default',
      '`qualities` Default',
      'Local IP Restriction',
      'Maximum Redirects',
      'AMP Support',
      '`next lint` Command',
      'Runtime Configuration',
      '`devIndicators` Options',
      '`experimental.dynamicIO` and `experimental.useCache`',
      '`unstable_rootParams`',
    ],
  },
  react: {
    to: 19,
    url: 'https://react.dev/blog/2024/04/25/react-19-upgrade-guide',
    counted: '"Breaking changes" and "TypeScript changes"',
    breaking: [
      'Errors in render are not re-thrown',
      'Removed: `propTypes` and `defaultProps` for functions',
      'Removed: Legacy Context using `contextTypes` and `getChildContext`',
      'Removed: string refs',
      'Removed: Module pattern factories',
      'Removed: `React.createFactory`',
      'Removed: `react-test-renderer/shallow`',
      'Removed: `react-dom/test-utils`',
      'Removed: `ReactDOM.render`',
      'Removed: `ReactDOM.hydrate`',
      'Removed: `unmountComponentAtNode`',
      'Removed: `ReactDOM.findDOMNode`',
      'Removed deprecated TypeScript types',
      '`ref` cleanups required',
      '`useRef` requires an argument',
      'Changes to the `ReactElement` TypeScript type',
      'The JSX namespace in TypeScript',
      'Better `useReducer` typings',
    ],
  },
  vite: {
    to: 8,
    url: 'https://vite.dev/guide/migration',
    counted: '"Default Browser Target Change", "Rolldown" and "Removed Deprecated Features"',
    breaking: [
      'Default Browser Target Change',
      'Dependency Optimizer Now Uses Rolldown',
      'esbuild Fallbacks',
      'JavaScript Minification by Oxc',
      'CSS Minification by Lightning CSS',
      'Consistent CommonJS Interop',
      'Removed Module Resolution Using Format Sniffing',
      'Require Calls For Externalized Modules',
      '`import.meta.url` in UMD / IIFE',
      'Removed `build.rollupOptions.watch.chokidar` option',
      'Removed object form `build.rollupOptions.output.manualChunks` and deprecate function form one',
      '`build()` Throws `BundleError`',
      'Module Type Support and Auto Detection',
      'Removed Deprecated Features',
    ],
  },
  vitest: {
    to: 5,
    url: 'https://vitest.dev/guide/migration',
    counted: 'every section but "Package Migration"',
    breaking: [
      'Yarn Users Must Install `vite` Explicitly',
      '`clearMocks` is Enabled by Default',
      '`testNamePattern` Matches the `>`-Joined Full Name',
      'Inline Projects Inherit the Root Config by Default',
      'Referenced Config Files Can Define Their Own Projects',
      'Inline Projects Share the Vite Server by Default',
      'Hoisted Mocking Calls Must Be at the Top Level',
      'Automocked Modules Stay Automocked in the Browser',
      'Class Mocks Keep Prototype Methods',
      'Benchmarking API Rewrite',
      'Vitest UI Requires an Authenticated URL',
      'Fake Timers and `setSystemTime` Now Mock `Temporal`',
      '`toThrow("")` Matches Any Error Message',
      'Assertion Types Expose Return and Received Types',
      '`expect.poll` Fails When It Times Out',
      'Unawaited Asynchronous Assertions Fail the Test',
      'Test Titles and Inspected Values Use `pretty-format`',
      'Removed `test.sequential`, `describe.sequential`, and `sequential` Options',
      'Locators in Commands are Serialized as Objects',
      'Locators are Strict by Default',
      '`toHaveTextContent` Now Performs Strict Equality',
      '`render` Is Async in `vitest-browser-vue` and `vitest-browser-svelte`',
      'Glob Coverage Thresholds No Longer Inherit `perFile`',
      'Coverage `include` and `exclude` Match More Precisely',
      'Config Files Are Not Looked Up From Parent Directories',
      'DOM Environment Global Assignments Now Update the Underlying Window',
      '`populateGlobal` Returns Descriptors in `originals`',
      'Browser Orchestrator URL Requires a Session',
      '`browser.api` Is Replaced by the Top-Level `api`',
      'Generated Reports and Artifacts Use the `.vitest` Directory',
      '`toMatchScreenshot` Now Uses a Dedicated Screenshot Directory Config',
      'Worker and Concurrency Ids Are 1-based',
      '`resolveConfig` Returns the Resolved Vite Config',
      'Removed Deprecated Entrypoints',
    ],
  },
  '@faker-js/faker': {
    to: 10,
    url: 'https://fakerjs.dev/guide/upgrading',
    counted: '"General Breaking Changes", runtime and module-format notes aside',
    breaking: ['Removal of Deprecated Code', 'Word Methods Default Resolution Strategy'],
  },
  '@typescript-eslint/utils': {
    to: 8,
    url: 'https://typescript-eslint.io/blog/announcing-typescript-eslint-v8',
    counted: '"User-Facing Changes" and "Developer-Facing Changes", new features aside',
    breaking: [
      'Updated Configuration Rules',
      'Replacement of `ban-types`',
      'Tooling Breaking Changes',
      'AST Breaking Changes',
      'Custom Rule `meta.docs` Types',
      'Flat Configuration `RuleTester`',
      'Other Developer-Facing Breaking Changes',
    ],
  },
  openai: {
    to: 7,
    url: 'https://github.com/openai/openai-node/blob/master/MIGRATION.md',
    counted: '"Breaking changes" (the guide covers 4 → 5, the first step of 4 → 7)',
    breaking: [
      'Web types for `withResponse`, `asResponse`, and `APIError.headers`',
      'Named path parameters',
      'URI encoded path parameters',
      'Removed request options overloads',
      'HTTP method naming',
      'Removed `httpAgent` in favor of `fetchOptions`',
      'Refactor of `openai/core`, `error`, `pagination`, `resource`, `streaming` and `uploads`',
      'Resource classes',
      'Cleaned up `uploads` exports',
      '`APIClient`',
      'File handling',
      'Shims removal',
      'Zod helpers optionality error',
      'Removed unnecessary classes',
      'Beta chat namespace removed',
      'Removed deprecated `.runFunctions` methods',
      '`.runTools()` event / method names',
      '`openai/src` directory removed',
    ],
  },
  eslint: {
    to: 10,
    url: 'https://eslint.org/docs/latest/use/migrate-to-10.0.0',
    counted: 'every section but codemods, the contents and Node.js versions',
    breaking: [
      '`eslint:recommended` has been updated',
      'New configuration file lookup algorithm',
      'Old config format no longer supported',
      'JSX references are now tracked',
      '`eslint-env` comments are reported as errors',
      'Jiti < v2.2.0 are no longer supported',
      'POSIX character classes in glob patterns',
      '`stylish` formatter now uses native `styleText` instead of `chalk`',
      'Deprecated options of the `radix` rule',
      '`no-shadow-restricted-names` now reports `globalThis` by default',
      '`func-names` schema is stricter',
      '`allowConstructorFlags` option of `no-invalid-regexp` now accepts only unique items',
      '`name` property added to ESLint core configs',
      'Removal of `type` property in errors of invalid `RuleTester` cases',
      '`Program` AST node range spans entire source text',
      'Fixer methods now require string `text` arguments',
      'New requirements for `ScopeManager` implementations',
      'Removal of deprecated `context` members',
      'Removal of deprecated `SourceCode` methods',
      'Prohibiting `errors` or `output` of valid RuleTester test cases',
      'Removal of `nodeType` property in `LintMessage` objects',
    ],
  },
  prettier: {
    to: 3,
    url: 'https://prettier.io/blog/2023/07/05/3.0.0.html',
    counted: '"Breaking Changes", Node.js versions aside',
    breaking: [
      'Change the default value for `trailingComma` to `all`',
      'Remove Flow syntax support from `babel` parser',
      'Remove support for Flow comments',
      'Print trailing comma in type parameters and tuple types when `--trailing-comma=es5`',
      'Add the pure `css` parser',
      'Drop support for "comma separated interfaces" syntax',
      'Change public APIs to asynchronous',
      'Npm package file structures changed',
      'Support plugins in ESM',
      'Update `prettier.doc`',
      '`textToDoc` trims trailing hard lines',
      'Removed support for custom parser api',
      'The second argument `parsers` passed to `parsers.parse` has been removed',
      "`undefined` and `null` are not passed to plugin's `print` function",
      'Allow using arbitrary truthy values for `label` docs',
      '`getFileInfo()` resolves config by default',
      'Plugin search feature has been removed',
      'Ignore `.gitignore`d files by default',
    ],
  },
  recharts: {
    to: 3,
    url: 'https://github.com/recharts/recharts/wiki/3.0-migration-guide',
    counted: 'the breaking sections, new features aside',
    breaking: [
      'No more `CategoricalChartState`',
      'Removal of internal props',
      'Other breaking changes',
      'Custom components',
    ],
  },
  'react-day-picker': {
    to: 10,
    url: 'https://daypicker.dev/docs/upgrading-v8-to-v10',
    counted: 'steps 2 to 7',
    breaking: [
      '2. Update CSS imports and styles',
      '3. Add `onSelect` when using `selected`',
      '4. Replace navigation boundary props',
      '5. Update custom components',
      '6. Update formatters, labels, and tests',
      'Removed props',
      'Removed hooks and internal providers',
      'Removed utility aliases',
      'Removed TypeScript and exported names',
    ],
  },
  'react-router': {
    to: 8,
    url: 'https://reactrouter.com/upgrading/v7',
    counted:
      '"Future Flags" and "Other Breaking Changes" (the guide covers 7 → 8, the last step of 6 → 8)',
    breaking: [
      '`future.v8_middleware`',
      '`future.v8_splitRouteModules`',
      '`future.v8_viteEnvironmentApi`',
      '`future.v8_passThroughRequests`',
      '`future.v8_trailingSlashAwareDataRequests`',
      '`meta`/`matches` `data` Values',
      '`react-router-dom`',
      'Cloudflare Vite Plugin',
      '`@react-router/architect` `useRequestContextDomainName`',
    ],
  },
  '@prisma/client': {
    to: 7,
    url: 'https://www.prisma.io/docs/guides/upgrade-prisma-orm/v7',
    counted: '"Breaking changes", prerequisites aside',
    breaking: [
      'ESM support',
      'Schema changes',
      'Driver adapters',
      'Prisma Accelerate',
      'SSL certificate validation changes',
      'Environment variables',
      'Prisma config',
      'Metrics removed',
      'Prisma ORM v6 behavior',
      'Prisma ORM v7 (reverted behavior)',
      'Client middleware removed',
      'Seeding changes',
      'Removed CLI flags',
      'Removed db execute flags',
      'Migrate diff changes',
      'Various environment variables have been removed',
    ],
  },
  '@sentry/core': {
    to: 11,
    url: 'https://github.com/getsentry/sentry-javascript/blob/develop/MIGRATION.md',
    counted: '"Behaviour Changes" and the API sections after it',
    breaking: [
      'Choosing an OpenTelemetry setup',
      'Connecting Sentry to your OpenTelemetry traces',
      'If you previously set `sendDefaultPii: true`',
      'If you want to keep the v10 default behavior',
      'RequestData',
      'Astro client IP',
      'Remix action form data',
      '`vercelAIIntegration` changes',
      '`setupKoaErrorHandler` is deprecated (Koa errors are captured automatically)',
      '`setupHapiErrorHandler` is deprecated (Hapi errors are captured automatically)',
      'Initializing via `--require` is no longer supported',
      'Scope `tags` and `extra` are not applied to spans',
      '`beforeSendSpan` receives the streamed span format',
      'Replacing `beforeSendTransaction`',
      'Replacing `ignoreTransactions` with `ignoreSpans`',
      '`ignoreStatusCodes` is deprecated',
      'Opting out of span streaming',
      '`Sentry.spanToJSON` returns streamed span format',
      'The `enableLogs` option was removed',
      'Browser sessions use `unhandled` instead of `crashed`',
      '`page` is the default browser session lifecycle mode',
      'Web vitals are reported per soft navigation',
      'CLS and LCP no longer report intermediate values',
      'Back/forward-cache restores report their own web vitals',
      'Web vital spans no longer carry a report event',
      '`DOMException.code` is no longer set as a tag',
      '`attachStacktrace` defaults to `true`',
      'Incoming HTTP span hooks moved to `onSpanCreated`',
      'Deno `node:http` server requests are tracked as sessions',
      '`propagateTrace` renamed to `tracePropagation`',
      'Deno server transactions are dropped for some 3xx/4xx status codes',
      '`tracePropagationTargets` matching is now case-insensitive',
      '`sendFeedback` rejects with an `Error`',
      'HTTP attributes',
      'Network attributes',
      'Messaging and database attributes',
      'GenAI attributes',
      'Other attributes',
      'Attribute constants',
      'Span operation (`op`) changes',
      'LangGraph no longer emits `create_agent` spans',
      'Express: errors are captured automatically',
      '`onUnhandledRejectionIntegration`: no warning before `Error` rejections in `strict` mode',
      'Browser navigation timing spans',
      'Serverless function spans',
      'SvelteKit function spans',
      'Filtering and sampling',
      'HTTP spans',
      'Routing and request handler spans',
      'GraphQL spans',
      'AI spans',
      'MCP spans',
      'Messaging spans',
      'Cache spans',
      'UI spans',
      'Database spans',
      'AI integrations no longer trace non-inference operations',
      'Fastify: `setupFastifyErrorHandler` is deprecated',
      '`@sentry/nextjs`',
      'Cloudflare: `nodejs_compat` compatibility flag is now required',
      'Cloudflare: `wrapRequestHandler` moved to `@sentry/cloudflare/request`',
      'Cloudflare: the Vite plugin auto-instruments your Worker by default',
      'Cloudflare: rate limiter bindings no longer emit spans',
      '`@sentry/nuxt`: the server config is bundled, `--import` is no longer needed',
      '`@sentry/ember` is now a v2 addon with manual setup',
      'React Router: Vite plugin moved to `@sentry/react-router/vite`',
      'Remix: Vite plugin moved to `@sentry/remix/vite`',
      'React: Simpler React Router setup via `@sentry/react/react-router`',
      '`@sentry/core` / All SDKs',
      '`@sentry/browser`',
      '`httpIntegration` options were consolidated',
      '`@sentry/cloudflare`',
      '`@sentry/opentelemetry`',
      'AI integrations',
      '`@sentry/react-router`',
      'Browser and Node profiling',
      '`@sentry/profiling-node`',
      '`@sentry/nextjs`',
      'Meta-framework build options',
      'Bundler plugins: Vercel deploys use the plain Vercel environment name',
      'Bundler plugins: `@sentry/bundler-plugins/webpack5` was removed',
      'Removed `unstable_` bundler plugin options',
      '`@sentry/nuxt`',
      '`@sentry/sveltekit`',
      '`@sentry/server-utils`',
      '`@sentry/astro`',
      '`@sentry/solidstart`',
      '`@sentry/types` is no longer published',
      '`@sentry/node-core` was merged back into `@sentry/node`',
      '`@sentry/tanstackstart` was removed',
      'Metrics moved out of the base CDN bundle',
      '`InboundFilters` integration renamed to `EventFilters`',
      '`instrumentLangGraph` renamed to `instrumentStateGraph`',
      '`childProcess` integration split into `childProcess` and `workerThreads`',
      'Deno default integrations renamed to match the other SDKs',
      '`denoHttpIntegration` incoming span hooks renamed',
      '`otlpIntegration` renamed to `openTelemetryIntegration`',
      '`sentrySvelteKit` moved to the `@sentry/sveltekit/vite` subpath export',
    ],
  },
  '@babel/core': {
    to: 8,
    url: 'https://babeljs.io/docs/v8-migration-api',
    counted: '"API Changes"',
    breaking: [
      'All packages',
      '`@babel/core`',
      '`@babel/generator`',
      '`@babel/types`',
      '`@babel/parser`',
      '`@babel/traverse`',
      '`@babel/eslint-plugin`',
      '`@babel/code-frame`',
      '`@babel/compat-data`',
      '`@babel/preset-env`',
      '`@babel/helper-replace-supers`',
      '`@babel/helper-simple-access`',
      '`@babel/highlight`',
      '`@babel/plugin-transform-runtime`',
      'Plugin API changes',
    ],
  },
  stylelint: {
    to: 17,
    url: 'https://stylelint.io/migration-guide/to-17',
    counted: '"Breaking changes", Node.js versions aside',
    breaking: [
      'Removed GitHub formatter',
      'Removed `resolveNestedSelectors` option from `selector-class-pattern`',
      'Removed `checkContextFunctionalPseudoClasses` option from `selector-max-id`',
      'Changed default `fix` mode to `strict`',
      'Changed `report` to be consistent and predictable in how it handles the provided position arguments',
      'Changed `selector-max-*` syntax rules for standard CSS nesting and modern functional pseudo-classes',
      'Changed `*-specificity` semantic rules for standard CSS nesting',
      'Changed `no-duplicate-selectors` and `selector-no-qualifying-type` for standard CSS nesting',
      'Changed `*-list` rules to have consistent behaviour for vendor prefixes and case',
      'Changed `*-no-vendor-prefix` rules to have consistent behaviour for their `ignore*: []` secondary options',
      'Changed `declaration-property-max-values` rule to have consistent behaviour for vendor prefixes',
    ],
  },
  rollup: {
    to: 4,
    url: 'https://rollupjs.org/migration/',
    counted: '"General Changes", "Configuration Changes" and "Changes to the Plugin API"',
    breaking: ['General Changes', 'Configuration Changes', 'Changes to the Plugin API'],
  },
  zustand: {
    to: 5,
    url: 'https://zustand.docs.pmnd.rs/migrations/migrating-to-v5',
    counted: '"Migration Guide"',
    breaking: [
      'Using custom equality functions such as `shallow`',
      'Requiring stable selector outputs',
      'Handling Dynamic `replace` Flag',
      'Persist middleware no longer stores item at store creation',
    ],
  },
  graphql: {
    to: 17,
    url: 'https://www.graphql-js.org/upgrade-guides/v16-v17',
    counted: 'the change sections, Node.js versions and tracing aside',
    breaking: [
      'Conditional exports',
      'Development mode',
      '`graphql()` and `graphqlSync()`',
      'GraphQL Harness',
      'Single-result execution',
      'Incremental delivery',
      'Disabling error propagation',
      'Resolver return values',
      'Custom execution helpers',
      'Subscription return type',
      'Lower-level subscription helpers',
      'Abort Signals',
      'Execution Hooks',
      'Default values',
      '`undefined` and omitted input values',
      'Coercion and validation helpers',
      'Built-in scalar `bigint` values',
      'Custom scalar method names',
      'Variable Values and Resolver Info',
      'Schema validation',
      'Programmatic schema APIs',
      'AST constants and visitors',
      'Directives on directive definitions',
      'Fragment arguments',
      'Validation',
      'Schema Change utilities',
      'Removed helpers',
      '`GraphQLError`',
    ],
  },
  '@opentelemetry/core': {
    to: 2,
    url: 'https://github.com/open-telemetry/opentelemetry-js/blob/main/doc/upgrade-to-2.x.md',
    counted: 'the sections marked 💥, Node.js and TypeScript versions aside',
    breaking: [
      '💥 Drop `window.OTEL_*` support in browsers',
      '💥 `@opentelemetry/resources` API changes',
      '💥 `@opentelemetry/core` API changes',
      '💥 Tracing SDK API changes',
      '💥 `@opentelemetry/sdk-metrics` API changes',
      'Synchronous Resource Detector migration',
      'Asynchronous Resource Detector migration',
      'Resource Detector test changes',
      '💥 Other changes',
    ],
  },
  nodemailer: {
    to: 10,
    url: 'https://github.com/nodemailer/nodemailer/blob/master/CHANGELOG.md',
    breaking: [],
  },
  jsdom: { to: 30, url: 'https://github.com/jsdom/jsdom/releases', breaking: [] },
  'cross-env': { to: 10, url: 'https://github.com/kentcdodds/cross-env#readme', breaking: [] },
  turbo: { to: 2, url: 'https://turborepo.dev/blog/turbo-2-0', breaking: [] },
};

/**
 * Packages whose diff cannot be read whole yet: date-fns 4 moved its subpath modules
 * (`date-fns/add`) to a layout the diff does not match, which reports every one removed.
 * Only changes to the main entry's exports count until it does.
 */
const MAIN_ENTRY_ONLY: Record<string, string> = {
  'date-fns':
    "counts only the main entry: the diff does not match v4's subpath modules (date-fns/add) yet",
};

interface Entry {
  package: string;
  /** The packages upgraded with it, hub first. */
  members: string[];
  from: string;
  to: string;
  why: string;
  status: 'todo' | 'in-progress' | 'candidate' | 'verified';
  /** Sample repositories declaring any member directly. */
  repos: number;
  /** Of those, the ones declaring the hub below `to`. */
  reposBehind: number;
  /**
   * The breaking changes the score counts from: every one the type diff reports, the
   * distinct ones (a change repeated across exports once), and the items the migration
   * guide lists when GUIDES records it. Absent when no diff could measure the package.
   */
  breaking?: { total: number; distinct: number; guide?: number };
  weeklyDownloads: number;
  codemod?: string;
}

const size = Number(process.argv.find((a) => a.startsWith('--size='))?.slice(7) ?? 25);
const root = join(import.meta.dirname, '..');
const file = join(root, 'packs', 'queue.json');
const previous: Entry[] = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).queue : [];

async function json<T>(url: string, accept = 'application/json'): Promise<T | undefined> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { accept } });
    if (res.ok) return (await res.json()) as T;
    if (res.status === 404) return undefined;
    if (attempt >= 6 || ![429, 500, 502, 503, 504].includes(res.status))
      throw new Error(`${url}: HTTP ${res.status}`);
    await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
  }
}
/** `fn` over `items`, `limit` at a time. */
async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i] as T);
      }
    }),
  );
  return out;
}
const encode = (name: string): string => name.replace('/', '%2F');

// 1. Direct declarations, per repository.
const corpus = JSON.parse(readFileSync(join(root, 'fixtures', 'corpus.json'), 'utf8')) as {
  repo: string;
  commit: string;
}[];
const repos = [...corpus.map((c) => [c.repo, c.commit] as const), ...SAMPLE];
/** package → repository → majors it declares there. */
const declared = new Map<string, Map<string, Set<number>>>();
for (const [repo, commit] of repos) {
  console.error(`reading ${repo}@${commit.slice(0, 12)}`);
  for (const [name, majors] of declaredIn(manifestsOf(repo, commit))) {
    const by = declared.get(name) ?? new Map<string, Set<number>>();
    by.set(repo, majors);
    declared.set(name, by);
  }
}
const own = new Set(registeredPacks().map((e) => e.pack.name));
const named = [...declared].filter(([name, by]) => by.size >= MIN_REPOS && !(name in NOT_A_PACK));

// 2. The latest version of each, then the full version list of those someone is behind on.
console.error(`${named.length} packages in ${MIN_REPOS}+ repositories: reading npm`);
const latest = new Map<string, Manifest>();
await pool(named, 16, async ([name]) => {
  const manifest = await json<Manifest>(`${REGISTRY}/${encode(name)}/latest`);
  if (manifest?.version) latest.set(name, manifest);
});
const majorOfVersion = (version: string): number => Number(version.split('.')[0]);
const behind = (name: string): Map<string, number> => {
  const to = majorOfVersion(latest.get(name)?.version ?? '0');
  const out = new Map<string, number>();
  for (const [repo, majors] of declared.get(name) ?? []) {
    const lowest = Math.min(...majors);
    if (Number.isFinite(lowest) && lowest < to) out.set(repo, lowest);
  }
  return out;
};
type Packument = {
  versions?: Record<string, Manifest>;
  'dist-tags'?: Record<string, string>;
};
const packuments = new Map<string, Packument>();
/** What `name`'s latest version re-exports: a dependency pinned at its own version. */
const reexports = (name: string): string | undefined => {
  const m = latest.get(name);
  return Object.entries(m?.dependencies ?? {}).find(
    ([dep, range]) => range === m?.version && latest.has(dep),
  )?.[0];
};
const outdated = named.filter(
  ([name]) =>
    latest.has(name) &&
    (behind(name).size > 0 ||
      // A types package moves with its runtime package, and what a facade re-exports with
      // the facade (react-router-dom → react-router): keep them to merge.
      name.startsWith('@types/') ||
      named.some(([other]) => behind(other).size > 0 && reexports(other) === name)),
);
await pool(outdated, 8, async ([name]) => {
  const doc = await json<Packument>(
    `${REGISTRY}/${encode(name)}`,
    'application/vnd.npm.install-v1+json',
  );
  if (doc?.versions) packuments.set(name, doc);
});
const STABLE = /^\d+\.\d+\.\d+$/;
const stable = new Map<string, string[]>();
const stableVersions = (name: string): string[] => {
  let versions = stable.get(name);
  if (!versions) {
    versions = Object.keys(packuments.get(name)?.versions ?? {}).filter((v) => STABLE.test(v));
    stable.set(name, versions);
  }
  return versions;
};
/** The newest release of `major`: the version an app behind on it has. */
const newestOf = (name: string, major: number): string | undefined =>
  stableVersions(name)
    .filter((v) => majorOfVersion(v) === major)
    .sort((a, b) => {
      const [x, y] = [a.split('.').map(Number), b.split('.').map(Number)];
      return (x[0] ?? 0) - (y[0] ?? 0) || (x[1] ?? 0) - (y[1] ?? 0) || (x[2] ?? 0) - (y[2] ?? 0);
    })
    .at(-1);
/** The major most repositories behind it declare. */
const fromMajor = (name: string): number | undefined => {
  const counts = new Map<number, number>();
  for (const major of behind(name).values()) counts.set(major, (counts.get(major) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]?.[0];
};

// 3. Groups: what `list` links, plus types and lockstep releases.
const names = [...packuments.keys()];
const listed = (name: string): ListedDependency | undefined => {
  const to = latest.get(name)?.version;
  const from = fromMajor(name);
  const current = from === undefined ? undefined : newestOf(name, from);
  if (!to || !current) return undefined;
  return {
    name,
    current,
    latest: to,
    change: 'major',
    tier: 'generic',
    majorGap: majorOfVersion(to) - majorOfVersion(current),
    classification: 'used',
    reasons: [],
    workspaces: ['.'],
    usage: {
      files: declared.get(name)?.size ?? 0,
      callSites: 0,
      references: 0,
      topSymbols: [],
      workspaces: ['.'],
    },
  } as ListedDependency;
};
const rows = new Map(names.flatMap((n) => (listed(n) ? [[n, listed(n) as ListedDependency]] : [])));
const manifestAt = (name: string, version: string): Manifest =>
  packuments.get(name)?.versions?.[version] ?? {};
const scopeOf = (name: string): string | undefined =>
  name.startsWith('@') && !name.startsWith('@types/') ? name.split('/')[0] : undefined;
/**
 * Released together: the same latest version and nearly the same release history (react and
 * react-dom, next and eslint-config-next). Matching versions alone can be coincidence (a
 * short history fits inside a long one), so it takes 20 shared releases, 80% of the shorter
 * history (react predates react-dom), and histories of comparable length.
 */
const sharedHistory = (a: string, b: string): { shared: number; short: number; long: number } => {
  const [x, y] = [new Set(stableVersions(a)), new Set(stableVersions(b))];
  return {
    shared: [...x].filter((v) => y.has(v)).length,
    short: Math.min(x.size, y.size),
    long: Math.max(x.size, y.size),
  };
};
const lockstep = (a: string, b: string): boolean => {
  if (latest.get(a)?.version !== latest.get(b)?.version) return false;
  const { shared, short, long } = sharedHistory(a, b);
  return shared >= 20 && shared >= 0.8 * short && short >= 0.5 * long;
};
const parent = new Map(names.map((n) => [n, n]));
const find = (n: string): string => {
  let r = n;
  while (parent.get(r) !== r) r = parent.get(r) as string;
  return r;
};
const why = new Map<string, Set<string>>();
const join2 = (a: string, b: string, reason: string): void => {
  parent.set(find(a), find(b));
  for (const n of [a, b]) why.set(n, (why.get(n) ?? new Set()).add(reason));
};
const pins = (m: Manifest): string[] =>
  Object.entries(m.dependencies ?? {})
    .filter(([, v]) => /^\d+\.\d+\.\d+/.test(v))
    .map(([d]) => d);
/** `host` is a required peer of `dependent`'s latest version (an optional one moves nothing). */
const peerOf = (dependent: Manifest, host: string): boolean =>
  host in (dependent.peerDependencies ?? {}) &&
  !(dependent.peerDependenciesMeta as Record<string, { optional?: boolean }> | undefined)?.[host]
    ?.optional;
/** dependent → the hosts `list` says it needs moved. */
const hosts = new Map<string, string[]>();
for (const [i, a] of names.entries())
  for (const b of names.slice(i + 1)) {
    const [ra, rb] = [rows.get(a), rows.get(b)];
    const scoped = scopeOf(a) !== undefined && scopeOf(a) === scopeOf(b);
    if (lockstep(a, b)) {
      join2(a, b, scoped ? `${scopeOf(a)} released in lockstep` : 'released in lockstep');
      continue;
    }
    if (!ra || !rb) continue;
    const [ta, tb] = [manifestAt(a, ra.latest), manifestAt(b, rb.latest)];
    // Only pairs `list` could link outside a family: a required peer, or an exact pin in common.
    const [aNeedsB, bNeedsA] = [peerOf(ta, b), peerOf(tb, a)];
    if (!aNeedsB && !bNeedsA && !pins(ta).some((d) => pins(tb).includes(d))) continue;
    const metadata = new Map([
      [a, [manifestAt(a, ra.current)]],
      [b, [manifestAt(b, rb.current)]],
    ]);
    const targets = new Map([
      [a, { ...ta, peerDependencies: aNeedsB ? ta.peerDependencies : {} }],
      [b, { ...tb, peerDependencies: bNeedsA ? tb.peerDependencies : {} }],
    ]);
    const reason = dependencyGroups([{ ...ra }, { ...rb }], metadata, targets)[0]?.reason ?? '';
    // A shared pin: moving one alone leaves two copies of what both pin.
    const shared = reason
      .split(', ')
      .filter((r) => r.startsWith('shared '))
      .join(', ');
    if (shared) join2(a, b, shared);
    else if (reason.includes('peer link')) {
      if (aNeedsB) hosts.set(a, [...(hosts.get(a) ?? []), b]);
      if (bNeedsA) hosts.set(b, [...(hosts.get(b) ?? []), a]);
    }
  }
// `@types/react` moves with `react`, `@types/scope__name` with `@scope/name`.
for (const name of names.filter((n) => n.startsWith('@types/'))) {
  const runtime = name.slice('@types/'.length).replace(/^([^_]+)__/, '@$1/');
  if (parent.has(runtime)) join2(name, runtime, `types for ${runtime}`);
}

/**
 * A peer link attaches a plugin to its host: a package named as one (eslint-plugin-x,
 * prettier-plugin-x, @vitejs/plugin-react) joins the host its name starts from, unless it
 * already moves with something else (eslint-config-next is released with next). A library
 * that needs its peer moved (react-router, which needs react 19) keeps its own entry: its
 * pack migrates its own API, and `why` names the peer.
 */
const PLUGIN = /(?:^|[-/])(?:plugin|config|preset|loader)(?:[-/]|$)/;
const needs = new Map<string, string[]>();
for (const [dependent, needed] of hosts) {
  const bare = (n: string) => n.replace(/^@[^/]+\//, '');
  const host = PLUGIN.test(dependent)
    ? needed
        .filter((h) => dependent.includes(bare(h)))
        .sort((x, y) => dependent.indexOf(bare(x)) - dependent.indexOf(bare(y)))[0]
    : undefined;
  const alone = names.filter((n) => find(n) === find(dependent)).length === 1;
  if (host && alone) join2(dependent, host, `plugin of ${host}`);
  else needs.set(dependent, needed);
}
/**
 * A facade moves with what it re-exports: react-router-dom 7 is react-router at the same
 * version, motion is framer-motion. Its users migrate to the package it re-exports, which
 * is the hub. Pinning a dependency that happens to share the version is no facade
 * (eslint-config-next 16.4.0 pinning globals 16.4.0): a facade was released with what it
 * re-exports, 20 shared releases and 80% of the shorter history.
 */
const facades = new Map<string, string>();
for (const name of names) {
  const target = reexports(name);
  const history = target ? sharedHistory(name, target) : undefined;
  if (
    target &&
    parent.has(target) &&
    history &&
    history.shared >= 20 &&
    history.shared >= 0.8 * history.short
  ) {
    facades.set(name, target);
    join2(name, target, `${name} re-exports ${target}`);
  }
}

// 4. Entries: one per group, named after its hub, ranked by direct use.
const components = new Map<string, string[]>();
for (const n of names) components.set(find(n), [...(components.get(find(n)) ?? []), n]);
const entries: (Entry & {
  score: number;
  weight: number;
  versions: [string, string];
  stand?: string;
})[] = [];
for (const members of components.values()) {
  if (members.some((m) => own.has(m))) continue;
  const runtime = members.filter((m) => !m.startsWith('@types/') && packuments.has(m));
  if (runtime.length === 0) continue;
  const repoSet = new Set(members.flatMap((m) => [...(declared.get(m)?.keys() ?? [])]));
  // The hub: what the facades re-export, else the member most repositories declare (react,
  // not react-dom; next, not eslint-config-next).
  const used = (m: string) => declared.get(m)?.size ?? 0;
  const targets = new Set(members.flatMap((m) => facades.get(m) ?? []));
  const hub = [...runtime].sort(
    (a, b) =>
      Number(targets.has(b)) - Number(targets.has(a)) || used(b) - used(a) || a.localeCompare(b),
  )[0];
  const hubLatest = hub && latest.get(hub)?.version;
  if (!hub || !hubLatest) continue;
  const to = majorOfVersion(hubLatest);
  // Behind: repositories declaring the hub, or a facade of it, below its latest major.
  const behindRepos = new Map<string, number>();
  for (const m of [hub, ...members.filter((m) => facades.get(m) === hub)])
    for (const [repo, majors] of declared.get(m) ?? []) {
      const lowest = Math.min(...majors);
      if (Number.isFinite(lowest) && lowest < to)
        behindRepos.set(repo, Math.min(lowest, behindRepos.get(repo) ?? lowest));
    }
  if (behindRepos.size < MIN_REPOS) {
    console.error(`left out ${hub}: ${behindRepos.size} sample repositories behind ${to}`);
    continue;
  }
  const counts = new Map<number, number>();
  for (const major of behindRepos.values()) counts.set(major, (counts.get(major) ?? 0) + 1);
  const from = [...counts].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]?.[0] as number;
  const fromVersion = newestOf(hub, from) ?? `${from}.0.0`;
  const codemod = CODEMODS[hub]?.to === to ? CODEMODS[hub] : undefined;
  if (codemod?.covers === 'all') {
    console.error(`left out ${hub}: ${codemod.note} (${codemod.url})`);
    continue;
  }
  const pack = registeredPacks().find((e) => e.pack.name === hub);
  const covered = pack?.pack.supports(fromVersion, hubLatest) ? pack : undefined;
  const kept = previous.find((p) => p.package === hub && p.to === `>=${to} <${to + 1}`)?.status;
  const typesOf = `@types/${hub.replace(/^@([^/]+)\//, '$1__')}`;
  entries.push({
    package: hub,
    members: [hub, ...members.filter((m) => m !== hub).sort()],
    from: `>=${from} <${from + 1}`,
    to: `>=${to} <${to + 1}`,
    why: '',
    status: covered ? packStatus(covered) : kept === 'in-progress' ? 'in-progress' : 'todo',
    repos: repoSet.size,
    reposBehind: behindRepos.size,
    weeklyDownloads: 0,
    ...(codemod ? { codemod: `${codemod.url} (${codemod.note})` } : {}),
    score: 0,
    weight: repoSet.size * (codemod ? PARTIAL_CODEMOD : 1),
    versions: [fromVersion, hubLatest],
    ...(members.includes(typesOf) ? { stand: typesOf } : {}),
  });
}
entries.sort((a, b) => b.weight - a.weight || a.package.localeCompare(b.package));

/**
 * What a pack would migrate: the breaking changes `check` finds between the two type
 * surfaces (the diff Uptide runs on every upgrade). A major that changes none (clsx 2,
 * nanoid 6: ESM-only, a newer Node) leaves nothing to rewrite. A package without types is
 * read through its `@types` member (express → @types/express). Cached per version pair.
 */
const diffCache = join(homedir(), '.cache', 'uptide', 'queue-diff');
/** A diff's breaking changes, all of them and the distinct ones. */
interface Breaking {
  total: number;
  /** removed + shapes: what a pack has to handle, each repeated change once. */
  distinct: number;
  /** Exports removed or renamed: each one is its own rewrite. */
  removed: number;
  /** Distinct change shapes among the rest (lucide-react: one type change on every icon). */
  shapes: number;
}
/**
 * The same change repeated across many exports is one change to migrate: lucide-react 1
 * changes every icon's type the same way. A change's shape is its kind and its before and
 * after text, with the symbol's own name taken out; each shape counts once. A removed or
 * renamed export counts once each, and a change reported again under an alias not at all.
 */
function distinctBreaking(changes: Change[]): Breaking {
  const removed = new Set<string>();
  const shapes = new Set<string>();
  for (const c of changes) {
    if (c.aliasOf) continue;
    if (c.kind === 'removed' || c.kind === 'moved' || c.replacement) {
      removed.add(c.path);
      continue;
    }
    const own =
      c.path
        .split(/[#.:"()[\]\s]+/)
        .filter(Boolean)
        .at(-1) ?? '';
    const strip = (text = '') => (own ? text.split(own).join('∗') : text);
    shapes.add(`${c.kind}|${strip(c.before)}|${strip(c.after)}`);
  }
  return {
    total: changes.length,
    distinct: removed.size + shapes.size,
    removed: removed.size,
    shapes: shapes.size,
  };
}
/** `7587 breaking API changes, 132 distinct (131 removed or renamed, 1 change shape)`. */
const describe = (b: Breaking): string =>
  b.distinct === b.total
    ? `${b.total} breaking API changes`
    : `${b.total} breaking API changes, ${b.distinct} distinct (${b.removed} removed or renamed, ${b.shapes} change shape${b.shapes === 1 ? '' : 's'})`;
async function breakingChanges(
  name: string,
  from: string,
  to: string,
  mainOnly = false,
): Promise<Breaking | string> {
  const key = `${name.replace('/', '__')}@${from}..${to}${mainOnly ? '.main' : ''}.v2`;
  const file = join(diffCache, `${key}.json`);
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')) as Breaking;
  try {
    const changes = await diffPackage({ name, from, to });
    // A subpath's symbols are written `"./add":add`; the main entry's are bare.
    const breaking = distinctBreaking(
      changes.filter((c) => c.severity === 'breaking' && !(mainOnly && c.path.startsWith('"'))),
    );
    mkdirSync(diffCache, { recursive: true });
    writeFileSync(file, JSON.stringify(breaking));
    return breaking;
  } catch (err) {
    // Why it could not be measured: no types to read, or the diff itself failed.
    const why = (err as Error).message.split('\n')[0] ?? 'unknown error';
    console.error(`${name} ${from} → ${to}: ${why}`);
    return why.includes('no type declarations')
      ? 'no type declarations'
      : `the diff failed (${why})`;
  }
}
/** score = direct use × log2(1 + breaking type changes), a partial codemod counting 0.9. */
const scoreOf = (weight: number, breaking: number): number =>
  weight * Math.log2(1 + Math.min(breaking, MAX_BREAKING));
const ranked: (typeof entries)[number][] = [];
const api = new Map<string, string>();
for (const e of entries) {
  // Entries are in order of direct use: once even the most breaking changes counted could
  // not reach the last place, nothing after can.
  const last = [...ranked].sort((a, b) => b.score - a.score)[size - 1]?.score ?? 0;
  if (ranked.length >= size && scoreOf(e.weight, MAX_BREAKING) < last) break;
  console.error(`diffing ${e.package} ${e.versions[0]} → ${e.versions[1]}`);
  const mainOnly = e.package in MAIN_ENTRY_ONLY;
  let breaking: Breaking | string = await breakingChanges(e.package, ...e.versions, mainOnly);
  let via = mainOnly ? `; ${MAIN_ENTRY_ONLY[e.package]}` : '';
  if (typeof breaking === 'string' && e.stand) {
    const standFrom = newestOf(e.stand, majorOfVersion(e.versions[0]));
    const standTo = latest.get(e.stand)?.version;
    if (standFrom && standTo) {
      breaking = await breakingChanges(e.stand, standFrom, standTo);
      via = ` (${e.stand} ${standFrom} → ${standTo})`;
    }
  }
  const guide =
    GUIDES[e.package]?.to === majorOfVersion(e.versions[1]) ? GUIDES[e.package] : undefined;
  const listed = guide?.breaking.length ?? 0;
  const source = guide ? `the migration guide lists ${listed} (${guide.url})` : '';
  if (typeof breaking === 'string') {
    // Not measured: only a guide or changelog listing API changes lets it in.
    if (listed === 0) {
      console.error(
        `left out ${e.package}: ${breaking}, and ${guide ? `its guide lists no API change (${guide.url})` : 'no guide recorded in GUIDES'}`,
      );
      continue;
    }
    const counted = Math.max(MIN_BREAKING, listed);
    e.breaking = undefined;
    e.score = scoreOf(e.weight, counted);
    api.set(
      e.package,
      `API change not measured (${breaking}); ${source}: ${guide?.breaking.join('; ')}; scored as ${counted}`,
    );
    ranked.push(e);
    continue;
  }
  // The guide's count wins when the type diff cannot see the break (CSS, config, runtime).
  const counted = Math.max(breaking.distinct, listed);
  e.breaking = {
    total: breaking.total,
    distinct: breaking.distinct,
    ...(guide ? { guide: listed } : {}),
  };
  if (counted < MIN_BREAKING) {
    console.error(
      `left out ${e.package}: ${breaking.distinct} distinct breaking API changes${listed ? `, ${source}` : ''}${via}`,
    );
    continue;
  }
  e.score = scoreOf(e.weight, counted);
  api.set(
    e.package,
    `${describe(breaking)} from ${e.versions[0]} to ${e.versions[1]}${via}${
      listed > breaking.distinct
        ? `; type diff understates: ${source}, scored as ${listed}: ${guide?.breaking.join('; ')}`
        : ''
    }`,
  );
  ranked.push(e);
}
ranked.sort((a, b) => b.score - a.score || a.package.localeCompare(b.package));
// Downloads break ties only, so they are read for tied entries that can still place. The
// registry's search carries them (the weekly count api.npmjs.org gives), so the script needs
// registry.npmjs.org alone; it rate-limits, hence two at a time.
const cut = ranked[Math.min(size, ranked.length) - 1]?.score ?? 0;
const scores = ranked.map((e) => e.score);
const tied = ranked.filter(
  (e) => e.score >= cut && scores.indexOf(e.score) !== scores.lastIndexOf(e.score),
);
await pool(tied, 2, async (e) => {
  const page = await json<{
    objects: { package: { name: string }; downloads?: { weekly?: number } }[];
  }>(`${REGISTRY}/-/v1/search?text=${encodeURIComponent(e.package)}&size=20`);
  e.weeklyDownloads =
    page?.objects.find((o) => o.package.name === e.package)?.downloads?.weekly ?? 0;
});
const queue = ranked
  .sort(
    (a, b) =>
      b.score - a.score ||
      b.weeklyDownloads - a.weeklyDownloads ||
      a.package.localeCompare(b.package),
  )
  .slice(0, size)
  .map(({ score: _score, weight: _weight, versions: _versions, stand: _stand, ...e }) => {
    const together = e.members.length > 1 ? `; upgraded with ${e.members.slice(1).join(', ')}` : '';
    const reasons = [
      ...(why.get(e.package) ?? []),
      ...(needs.get(e.package) ?? []).map((h) => `needs ${h} moved`),
    ];
    return {
      ...e,
      why: `declared directly in ${e.repos} of ${repos.length} sample repositories, ${e.reposBehind} of them on an older major; ${api.get(e.package)}${together}${reasons.length ? ` (${reasons.join(', ')})` : ''}`,
    };
  });
writeFileSync(
  file,
  `${JSON.stringify(
    {
      $comment:
        'Generated by `pnpm packs:queue`: ranked by how many sample repositories (fixtures/corpus.json and scripts/packs-queue-sample.ts, pinned public applications) declare the package directly, weekly downloads breaking ties; packages that upgrade together are one entry named after their hub. Pick one, say so in a pack-request issue, and follow CONTRIBUTING.md, "Write a pack".',
      generated: new Date().toISOString().slice(0, 10),
      sample: repos.length,
      queue,
    },
    null,
    2,
  )}\n`,
);
// As the repository formats it (the local Biome, never a downloaded one).
execFileSync(join(root, 'node_modules', '.bin', 'biome'), ['format', '--write', file], {
  stdio: 'ignore',
});
console.log(`${file}: ${queue.length} packages`);
for (const e of queue)
  console.log(
    `  ${String(e.repos).padStart(2)} repos (${String(e.reposBehind).padStart(2)} behind)  ${e.package} ${e.from} → ${e.to}${e.members.length > 1 ? `  + ${e.members.slice(1).join(', ')}` : ''}${e.codemod ? `  codemod: ${e.codemod}` : ''}`,
  );
