import { definePack, type PackRule } from '../contract.js';
import type { TransformResult } from '../types.js';
import { dropRefCallbackReturn, refCallbackReturnSites } from './detect.js';

/**
 * react >=18 <19 → >=19 <20, with react-dom and the @types packages that move with it. Taken
 * from the official React 19 upgrade guide and the 19.0.0 changelog (`meta.sources`), checked
 * 2026-10-08 against react 19.3.0. What the compiler rejects is `breaking`, what it only
 * strikes through is `deprecated`, and what compiles and behaves differently is a behavior
 * note, listed for review. `types-react-codemod preset-19` and `react/19/migration-recipe`
 * cover several of these; a rule that overlaps one says what the codemod leaves undone.
 */

/** Where a line's trailing `//` comment starts, outside strings; the line's length without one. */
function codeEnd(line: string): number {
  let quote: string | undefined;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = undefined;
    } else if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '/' && line[i + 1] === '/') return i;
  }
  return line.length;
}

/** The index just after the `>` closing the type arguments that open at `open`, or -1. */
function closeTypeArguments(code: string, open: number): number {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const c = code[i];
    // `=>` inside a function type is an arrow, not a closing bracket.
    if (c === '=' && code[i + 1] === '>') i++;
    else if (c === '<') depth++;
    else if (c === '>' && --depth === 0) return i + 1;
  }
  return -1;
}

/** `useRef<T>()` and `useRef()` at the reported line become `useRef<T>(undefined)`. */
function useRefArgument(text: string, line: number): TransformResult {
  const lines = text.split('\n');
  const current = lines[line - 1] ?? '';
  const end = codeEnd(current);
  const code = current.slice(0, end);
  const empty: number[] = [];
  for (const match of code.matchAll(/(?<![\w$])(?:[\w$]+\.)?useRef(?![\w$])/g)) {
    let at = match.index + match[0].length;
    if (code[at] === '<') {
      at = closeTypeArguments(code, at);
      if (at < 0) continue;
    }
    const call = /^\(\s*\)/.exec(code.slice(at));
    if (call) empty.push(at);
  }
  if (empty.length !== 1)
    return { text, applied: false, reason: 'the reported line is not one `useRef()` call' };
  const at = empty[0] as number;
  const call = /^\(\s*\)/.exec(code.slice(at)) as RegExpExecArray;
  lines[line - 1] =
    `${code.slice(0, at)}(undefined)${code.slice(at + call[0].length)}${current.slice(end)}`;
  return {
    text: lines.join('\n'),
    applied: true,
    reason: '`useRef` takes an initial value in React 19: `undefined` keeps what it was',
  };
}

/** `React.MutableRefObject<T>` at the reported line becomes `React.RefObject<T>`. */
function mutableRefObject(text: string, line: number): TransformResult {
  const lines = text.split('\n');
  const current = lines[line - 1] ?? '';
  const end = codeEnd(current);
  const code = current.slice(0, end);
  const names = [...code.matchAll(/(?<![\w$])MutableRefObject(?![\w$])/g)];
  if (names.length !== 1)
    return { text, applied: false, reason: 'the reported line is not one `MutableRefObject`' };
  const at = (names[0] as RegExpMatchArray).index as number;
  // Unqualified, the name comes from an import that would need `RefObject` beside it.
  if (!code.slice(0, at).endsWith('.'))
    return {
      text,
      applied: false,
      reason: 'an imported `MutableRefObject` needs its import edited',
    };
  lines[line - 1] =
    `${code.slice(0, at)}RefObject${code.slice(at + 'MutableRefObject'.length)}${current.slice(end)}`;
  return {
    text: lines.join('\n'),
    applied: true,
    reason: '`MutableRefObject<T>` is `RefObject<T>`: every ref is mutable in React 19',
  };
}

const rules: PackRule[] = [
  {
    id: 'use-ref-argument',
    summary: '`useRef` requires an argument: `useRef<T>()` is `useRef<T>(undefined)`',
    severity: 'breaking',
    kinds: ['signature', 'required', 'type'],
    symbols: /^TS2554$/,
    message: /Expected 1 arguments?, but got 0/,
    guide:
      'In React 19 types `useRef` always takes an initial value. `useRef<T>()` is `useRef<T>(undefined)`, which still types as `RefObject<T | undefined>`. Keep the type argument; do not change the initial value to anything but `undefined`. `types-react-codemod preset-19` (`useRef-required-initial`) does the same edit; it skips an aliased `useRef` import.',
    rewrite: (text, finding) => useRefArgument(text, finding.usage.line),
  },
  {
    id: 'ref-callback-return',
    summary:
      'a ref callback must not return a value: `ref={(el) => (x = el)}` is `ref={(el) => { x = el; }}`',
    severity: 'breaking',
    // Sites come from `detect`: the type of the `ref` prop is the one that rejects the return.
    kinds: [],
    symbols: /$^/,
    guide:
      'A ref callback may return a cleanup function in React 19, so its types reject any other return value. An arrow function that assigns returns what it assigned: give it a block body and keep the assignment. `types-react-codemod` has `no-implicit-ref-callback-return` for the `ref` prop and skips other props that take refs.',
    detect: (text) => refCallbackReturnSites(text),
    rewrite: (text, finding) => dropRefCallbackReturn(text, finding),
  },
  {
    id: 'mutable-ref-object',
    summary: '`MutableRefObject<T>` is `RefObject<T>`: every ref is mutable in React 19',
    severity: 'deprecated',
    kinds: ['deprecated'],
    symbols: /MutableRefObject$/,
    guide:
      '`MutableRefObject<T>` is deprecated; `RefObject<T>` is `{ current: T }` and `useRef` returns it. Replace the type and import `RefObject` where the code imports `MutableRefObject`.',
    rewrite: (text, finding) => mutableRefObject(text, finding.usage.line),
  },
  {
    id: 'ref-object-nullable',
    summary:
      '`RefObject<T>` no longer includes `null`: write `RefObject<T | null>` where a ref starts empty',
    severity: 'breaking',
    kinds: ['type', 'signature'],
    symbols: /^TS(?:2322|2345)$/,
    message: /RefObject</,
    guide:
      '`useRef<T>(null)` is `RefObject<T | null>` in React 19 types, and `RefObject<T>` has a `current` of exactly `T`. A parameter, prop or field typed `RefObject<HTMLDivElement>` that receives such a ref becomes `RefObject<HTMLDivElement | null>`: edit the declaration the error points through, not the call site, and handle `current` being null where it is read. `types-react-codemod` has `refobject-defaults` for annotations; it skips an aliased `RefObject` import.',
  },
  {
    id: 'global-jsx-namespace',
    summary:
      'the global `JSX` namespace is gone: import `JSX` from "react", and type the JSX runtime in tsconfig',
    severity: 'breaking',
    kinds: ['type', 'signature', 'required'],
    symbols: /^TS(?:2741|2746|2786|7026)$/,
    guide:
      'The global `JSX` namespace was removed from @types/react: use `import type { JSX } from "react"` (or `React.JSX`) where code names `JSX.Element`, and move any `declare global { namespace JSX { ... } }` augmentation into `declare module "react/jsx-runtime"` (or "react" with `jsx: react`, "react/jsx-dev-runtime" with `react-jsxdev`). With `jsx: react-jsx` and several copies of the React types, setting `jsxImportSource: "react"` in tsconfig points the compiler at one. Many diagnostics at JSX elements (7026, 2786, 2741, 2746) can come from this one cause: fix it once, then recompile. `types-react-codemod` has `scoped-jsx`.',
  },
  {
    id: 'element-props-unknown',
    summary:
      '`ReactElement["props"]` is `unknown` unless the element is typed: `ReactElement<{ ... }>`',
    severity: 'breaking',
    kinds: ['type', 'signature'],
    symbols: /^TS(?:2339|18046)$/,
    message: /(?:\.props' is of type 'unknown'|Property 'props' does not exist on type)/,
    guide:
      'An element typed `ReactElement` has `props: unknown`. Give the element the props type it is read as (`ReactElement<{ className?: string }>`, narrowed with `isValidElement<T>`), and cast with `as` where code receives a `ReactNode` child. Never type it `any` to silence the error. `types-react-codemod react-element-default-any-props` adds the explicit `any` this advises against; review each site.',
  },
  {
    id: 'removed-react-dom',
    summary:
      '`ReactDOM.render`, `hydrate`, `unmountComponentAtNode` and `findDOMNode` are removed: use `createRoot`, `hydrateRoot`, `root.unmount()` and a ref',
    severity: 'breaking',
    kinds: ['removed', 'type'],
    symbols: /(?:^TS2339$|(?:^|:)(?:render|hydrate|unmountComponentAtNode|findDOMNode)$)/,
    message: /(?:'(?:render|hydrate|unmountComponentAtNode|findDOMNode)'|^$)/,
    guide:
      'Import `createRoot` or `hydrateRoot` from "react-dom/client". `ReactDOM.render(el, container)` is `createRoot(container).render(el)`, and the root is what `unmount()` is called on (keep it where `unmountComponentAtNode(container)` was); `ReactDOM.hydrate` is `hydrateRoot(container, el)`; `findDOMNode(node)` is a ref on the DOM node. In tests, `act` comes from "react", and the Testing Library `cleanup` unmounts. The `react/19/migration-recipe` codemod rewrites `ReactDOM.render` and `hydrate`; it leaves `unmountComponentAtNode` and `findDOMNode` for you.',
  },
  {
    id: 'props-with-ref',
    summary: '`PropsWithRef<P>` is `P`: `ref` is a regular prop',
    severity: 'deprecated',
    kinds: ['deprecated'],
    symbols: /PropsWithRef$/,
    guide:
      '`PropsWithRef<P>` is deprecated: `ref` is a prop in React 19, so use `P`. Leave `PropsWithChildren` and the rest of the type as written.',
  },
];

export const reactPack = definePack({
  meta: {
    package: 'react',
    from: '>=18 <19',
    to: '>=19 <20',
    sources: [
      {
        title: 'React 19 Upgrade Guide',
        url: 'https://react.dev/blog/2024/04/25/react-19-upgrade-guide',
      },
      {
        title: 'React 19.0.0 changelog',
        url: 'https://github.com/facebook/react/blob/main/CHANGELOG.md#1900-december-5-2024',
      },
      {
        title: 'types-react-codemod (preset-19)',
        url: 'https://github.com/eps1lon/types-react-codemod',
      },
    ],
    maintainer: 'uptide-dev',
  },
  defaultTarget: '19.3.0',
  rules,
  behavior: [
    {
      id: 'errors-not-rethrown',
      summary:
        'errors thrown in render are no longer re-thrown: uncaught ones go to `window.reportError`, caught ones to `console.error`; error reporting that relied on the re-throw needs `onUncaughtError` and `onCaughtError` on `createRoot`',
      reported: ['decision'],
    },
    {
      id: 'removed-legacy-apis',
      summary:
        '`propTypes` and `defaultProps` on function components, legacy context (`contextTypes`, `getChildContext`), string refs, module-pattern factories, `React.createFactory` and `react-test-renderer/shallow` are removed at runtime: default parameters, `createContext`, ref callbacks and JSX replace them, and the compiler only sees some of them',
      reported: ['decision'],
    },
    {
      id: 'act-moved-to-react',
      summary:
        '`act` from "react-dom/test-utils" warns: import it from "react"; the other test-utils exports are removed',
      reported: ['decision'],
    },
    {
      id: 'element-ref-deprecated',
      summary:
        'reading `element.ref` warns: `ref` is a prop, read `element.props.ref`; cloneElement and Children code that touches the ref should be looked at',
      reported: ['decision'],
    },
    {
      id: 'strict-mode-memoization',
      summary:
        "in development, Strict Mode reuses the first render's `useMemo` and `useCallback` results on the second render and double-invokes ref callbacks on mount; code that was Strict Mode safe does not notice",
      reported: ['decision'],
    },
    {
      id: 'suspense-fallback-first',
      summary:
        'a suspended component commits the nearest Suspense fallback at once and renders its siblings afterwards, so siblings of a suspending component no longer render before the fallback shows',
      reported: ['decision'],
    },
    {
      id: 'umd-removed',
      summary:
        'React no longer ships UMD builds: a script tag needs an ES module CDN, or a bundler',
      reported: ['decision'],
    },
    {
      id: 'javascript-urls-blocked',
      summary:
        '`javascript:` URLs in `href` and `src` throw, and an empty `src` or `href` (except on `a`) is no longer set',
      reported: ['decision'],
    },
    {
      id: 'use-reducer-types',
      summary:
        '`useReducer<React.Reducer<S, A>>(reducer)` no longer types: pass no type arguments and annotate the reducer, or pass `<State, [Action]>`',
      reported: ['decision'],
    },
  ],
  instructions:
    'Migrate only the reported site to React 19, from the compiler error and the guide above. Keep every value, handler, effect and render result as it is. Never cast to `any` or suppress a diagnostic to make it compile. If the site needs a decision the guide leaves open (which props type an element is read as, whether a root can be unmounted from where the code stands), say so instead of choosing.',
});
