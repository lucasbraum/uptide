---
"uptide": patch
---

A candidate migration pack for React 18 → 19, scored against excalidraw/excalidraw and
tldraw/tldraw at the commit before their own upgrade. Rewrites by rule: `useRef<T>()` →
`useRef<T>(undefined)`, `ref={(el) => (x = el)}` → a block body, and `React.MutableRefObject`
→ `React.RefObject`. `RefObject<T | null>`, the removed global `JSX` namespace, untyped
`element.props`, the removed react-dom APIs and `PropsWithRef` go to the agent with the guide;
what the compiler cannot see (errors no longer re-thrown, removed legacy APIs, `act` moved to
"react", Strict Mode and Suspense changes) is listed for review. It stays a candidate: `check`
does not yet move `@types/react` with `react`, and it reports 477 breaking sites that the
compiler accepts, so `check`, `list` and `fix` treat `react` as generic.
