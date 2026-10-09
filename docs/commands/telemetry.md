---
title: uptide telemetry
description: Anonymous telemetry is off by default; the switches, what an event contains, and where it is stored.
---

# `uptide telemetry`

For anyone who wants to know what Uptide would send before saying yes, and how to say no.
The exact fields and the maintainers' deployment requirements are in
[telemetry internals](../telemetry.md).

On your first interactive run, Uptide asks once whether to share anonymous usage; pressing
Enter means **no**. CI, `--ci`, `--json`, help/version and piped runs never prompt.

```sh
uptide telemetry on        # save consent
uptide telemetry off       # revoke consent and erase local telemetry identifiers and the last event
uptide telemetry status    # effective consent, overrides and transport configuration
uptide telemetry show      # the last sanitized event as JSON, without sending it
```

`--json` is available for all four actions. `UPTIDE_TELEMETRY=0` always disables
collection. CI (including `--ci`) requires an explicit `UPTIDE_TELEMETRY=1` for that run,
even when the saved preference is on.

With consent, events contain a random installation ID, a salted repository hash,
command/version, proven public npm package versions, aggregate counts, verification result,
timings and cost. No IP, code, paths, repository names or user names are collected. When
assisted fixes ran, the event adds only the provider and a public model ID; private or custom
model IDs become `custom`. Data is stored in **PostHog Cloud EU**, with a **90-day retention
policy**. Delivery is best effort in a short-lived background process; unavailable telemetry
never fails a command. Builds without a capture key send nothing.
