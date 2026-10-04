# Anonymous telemetry

Telemetry is **off by default**. On the first eligible interactive command, Uptide
asks once; Enter, no, EOF or cancellation means no. Help, version, telemetry controls,
CI, `--ci`, `--json` and piped runs never prompt. A saved opt-in also applies to later
noninteractive local runs. No account is required.

```sh
uptide telemetry on       # save consent
uptide telemetry off      # revoke consent and erase local telemetry identifiers/event
uptide telemetry status   # preference, effective state, overrides and transport availability
uptide telemetry show     # inspect the last sanitized event, or null
UPTIDE_TELEMETRY=0 npx uptide list  # always off
CI=1 UPTIDE_TELEMETRY=1 npx uptide check zod  # explicit opt-in for this CI run
```

`UPTIDE_TELEMETRY=0` overrides saved consent. CI (including `--ci`, GitHub Actions,
GitLab CI and Azure Pipelines) is off even with a saved opt-in, unless
`UPTIDE_TELEMETRY=1` is set for that run. The environment switch does not change the
saved preference. Turning the preference off cannot cancel an event already handed
to the sender, and an explicit environment opt-in remains effective until unset.
`--json` works with all four control commands; `show` always prints JSON.

## Storage and privacy

Events are stored in **PostHog Cloud EU (Frankfurt)** under a **90-day retention
policy**, after which they must be deleted. That policy is a deployment requirement:
maintainers must configure and verify server-side retention/deletion before enabling
capture in releases. No project key is included by default, so unconfigured builds
send nothing. The CLI cannot enforce retention on PostHog's servers.

Uptide collects **no IP addresses, code, source text, paths, repository names, user
names, Git remotes, command arguments, diagnostics, environment variables or secrets**.
It does not send OS/device identifiers, identify people, create person profiles or
perform GeoIP enrichment. Only the allowlisted fields below can leave the CLI.
The HTTPS receiver necessarily sees a network address to handle the connection; it
is not a telemetry property. `$ip` is explicitly null, `$geoip_disable` is true,
and the project must have **Discard client IP data** enabled so it is not stored.

The installation ID is random, not derived from a person or device. The repository
hash is HMAC-SHA256 over the local canonical repository path, using a random 32-byte
secret salt per installation. The salt and path never leave the machine. Hashes are
stable within one installation at the same path, but cannot be linked across
installations; moving the checkout changes its hash. These pseudonymous identifiers
allow repeated runs to be counted without knowing who or which repository they are.

## Exact event fields

One best-effort event is produced after a command completes. The capture envelope has
`api_key` (the public write-only project key), `event: "uptide_cli_run"`, and
`properties` with exactly these fields; there are no automatic SDK properties:

| Property | Value |
| --- | --- |
| `schema_version` | `1` |
| `distinct_id` | Random UUIDv4 installation ID |
| `repo_hash` | Salted hash described above, or `null` when unavailable |
| `command` | `status`, `list`, `check`, `plan`, `fix`, `verify`, `clean`, `pr`, `pr-body`, or `diff` |
| `version` | Published Uptide semver version |
| `packages` | Up to 100 objects containing only `name` and up to four exact semver `versions`, sorted |
| `counts` | Applicable aggregate integer counters: `packages`, `workspaces`, `breaking`, `deprecated`, `unverified`, `failed`, `partial`, `sites`, `files`, `tests`, `new_errors`, `changes`, `steps`, `removed`, `kept` |
| `durations_ms` | `total` and applicable `engine`, `fetch`, `diff`, `usages`, `compile`, `runtime`, `verification` durations in integer milliseconds |
| `verification` | `passed`, `failed`, or `not_run` |
| `cost_usd` | Aggregate assisted-fix cost, at most six decimal places; zero when unavailable |
| `exit_code` | `0`, `1`, or `2` |
| `$ip` | `null` |
| `$geoip_disable` | `true` |
| `$process_person_profile` | `false` |

Only exact package names/versions already proven by Uptide's existing anonymous
`https://registry.npmjs.org` metadata cache are included. Authenticated registry
responses, custom registries, old cache entries without provenance, private packages,
local paths, ranges and unproven versions are omitted. Telemetry performs **no extra
registry lookup**, including for private package names. Counts may include omitted
packages, but their identities do not leave the machine. Findings, symbols and
individual sites are never sent. Missing metrics are omitted or zero; failed runs
may contain only command, duration and exit status. Help/version and telemetry
controls are not events. PostHog supplies its own ingestion time and event metadata.

## Local files and delivery

Preferences and the secret salt live in `$XDG_CONFIG_HOME/uptide/telemetry.json`, or
`~/.config/uptide/telemetry.json`. Files are created with mode 0600 (directory 0700).
`telemetry-last.json` beside it holds only the last sanitized event, without the
project key. `show` reads it locally, revalidates package evidence and sends nothing;
if the cache has been removed, unproven versions disappear from this display.
It is an inspection aid, not a delivery receipt. A keyless build also lets you inspect
what would have been sent. `off` erases the event and ID/salt; a future opt-in creates
new identifiers. Unreadable settings fail closed. No files are written in your repo.

Plain HTTPS POST to `/capture/` uses Node's standard library, with no PostHog SDK.
A detached sender process has a **750 ms absolute deadline**, including DNS and TLS.
The CLI never waits for network delivery. There are no retries, redirects, queues,
flush-on-exit delays or error logs containing payloads. Delivery can be lost on fast
shutdown, offline machines or server failures; this never changes a command's result.
Local preparation and launching the sender have a small fixed overhead.

## Release configuration (maintainers)

The published bundle contains a write-only PostHog project key that cannot read data.

1. Create a PostHog Cloud **EU** project. Enable **Discard client IP data** and do not
   add transformations that identify users or enrich IP addresses. GeoIP is also
   disabled per event, because discarding IP alone does not prevent enrichment.
2. Arrange and verify automatic deletion after **90 days**, including the applicable
   storage/backups policy, with PostHog. Retention capabilities depend on the project
   plan; the capture API has no per-event TTL. A dashboard date filter is not deletion.
   Leave the release key unset until this policy is actually enforced.
3. Set the GitHub Actions repository secret **`UPTIDE_TELEMETRY_BUILD_KEY`** to the
   write-only project capture key (`phc_…`), never a personal API key. Both manual
   release workflows embed it at build time. It is public in the published bundle;
   it grants capture access only. No key is committed to this repository.
4. Both workflows set **`UPTIDE_TELEMETRY_BUILD_HOST=https://eu.i.posthog.com`**.
   Local builds may set these same build variables. Missing/invalid keys disable
   transport; invalid hosts also fail closed. Changing build variables rebuilds the CLI.
5. Verify a consenting test run and the project privacy/retention settings before
   publishing. This change does not configure a remote PostHog project or publish a release.

For tests, **`UPTIDE_TELEMETRY_HOST`** overrides the host at runtime. It must be an
HTTPS origin without credentials, paths, queries or fragments. It does not enable
telemetry or supply a key. Use a local HTTPS collector and a trusted test certificate;
no real PostHog project is needed for tests. Tests use synthetic payloads and never
send events to the production host.

Provider references: [capture API and EU endpoint](https://posthog.com/docs/api),
[IP handling and EU storage](https://posthog.com/docs/privacy/data-storage),
[anonymous events](https://posthog.com/docs/data/anonymous-vs-identified-events),
[retention API](https://posthog.com/docs/api/events-retention).
