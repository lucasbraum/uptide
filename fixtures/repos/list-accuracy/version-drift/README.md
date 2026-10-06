# version-drift

Invented packages. Three workspaces on different versions of the same packages:

- `drift-sdk`: 5.0.0 in `apps/a`, 7.0.0 in `apps/b` and `apps/c`; latest 7.1.0 (majors drift).
- `@drift/core`: 1.0.0 in `apps/a`, 2.0.0 in `apps/b`; latest 3.0.0. With `@drift/react`, the
  `@drift/*` family group.
- `@drift/react`: 2.0.0 in both; latest 3.0.0 (one version).

Every consumer of `list`'s report (terminal, HTML, JSON, `check --group`, `plan`, telemetry,
the smoke assertions) is tested against it: one entry per package, with `versions[]`.
