---
"uptide": minor
---

A verified migration pack for React 18 → 19, scored against excalidraw/excalidraw and
tldraw/tldraw at the commit before their own upgrade. Rewrites by rule: `useRef<T>()` →
`useRef<T>(undefined)`, `ref={(el) => (x = el)}` → a block body, and `React.MutableRefObject`
→ `React.RefObject`. `RefObject<T | null>`, the removed global `JSX` namespace, untyped
`element.props`, the removed react-dom APIs and `PropsWithRef` go to the agent with the guide;
what the compiler cannot see (errors no longer re-thrown, removed legacy APIs, `act` moved to
"react", Strict Mode and Suspense changes) is listed for review. 2 public repositories, 100%
precision on breaking findings (89 sites, none false), recall 69% on breaking sites; the
sites it misses are listed in the pack test output.
