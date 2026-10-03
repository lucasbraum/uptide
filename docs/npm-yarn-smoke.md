# Package-manager smoke results

Validated with `pnpm smoke 20` and `pnpm smoke 22`, using the packed CLI in clean Docker containers. All 20 fixes exited 0, produced verified branches, and added zero type errors. No lifecycle-script trap ran.

Zod 3.23.8 → 4.6.5 uses mechanical rules (2 sites flat, 4 in workspaces). Stripe 14.25.0 → 22.6.2 uses a caller compatible with both SDKs; the API-pin and subscription-field examples still require assisted decisions and are tested separately by check. Both upgrades use `--no-llm`.

| Fixture | Node | Zod fix | Stripe fix | Result |
|---|---|---:|---:|---|
| npm | v20.20.2 | 8.9s | 14.7s | verified |
| npm-workspaces | v20.20.2 | 9.9s | 9.7s | verified |
| pnpm | v20.20.2 | 8.0s | 10.4s | verified |
| yarn | v20.20.2 | 5.9s | 10.0s | verified |
| yarn-berry | v20.20.2 | 6.9s | 9.9s | verified |
| npm | v22.23.3 | 6.1s | 11.3s | verified |
| npm-workspaces | v22.23.3 | 8.1s | 18.3s | verified |
| pnpm | v22.23.3 | 11.7s | 13.5s | verified |
| yarn | v22.23.3 | 9.3s | 13.4s | verified |
| yarn-berry | v22.23.3 | 6.3s | 11.2s | verified |

Lockfile entry counts below are identical on both Node versions. `+` added, `−` removed, `~` modified. Workspace declarations and catalogs are also validated; only the target declaration can change.

| Fixture | Zod lock entries | Stripe lock entries | Outside target subtree |
|---|---|---|---:|
| npm | +0 −0 ~1 | +0 −19 ~3 | 0 |
| npm-workspaces | +0 −0 ~2 | +0 −38 ~6 | 0 |
| pnpm | +2 −2 ~0 | +2 −40 ~0 | 0 |
| yarn | +1 −1 ~0 | +1 −22 ~0 | 0 |
| yarn-berry | +1 −1 ~0 | +1 −25 ~0 | 0 |

npm workspaces uses lockfile v2, whose compatibility tree duplicates records; flat npm uses v3. pnpm records packages and snapshots separately. Stripe removes its old qs dependency subtree; npm also updates dev/optional flags for @types/node and undici-types without changing their installed versions. Yarn Berry uses the node-modules linker; PnP is not supported.

Additional validation: lint and typecheck passed; offline tests 424 core + 92 CLI, network-enabled tests 439 core + 92 CLI (including the local bot-PR Action simulation).
