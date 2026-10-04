# 0014 — Opt-in anonymous CLI telemetry

Status: accepted

Discovery and analysis remain local. To understand command outcomes without collecting
source or identifying repositories, add optional aggregate events. Ask once in an
interactive terminal, default no. Environment opt-out dominates; CI requires explicit
per-run opt-in. All controls work without an account.

Use PostHog Cloud EU with a write-only capture key injected by the release pipeline,
plain HTTPS and no SDK. A strict field allowlist, random installation identity and
secret-salted repository hash prevent reports, arguments and paths from reaching the
wire. Package identities require prior anonymous public npm metadata evidence; never
query possibly private names just for telemetry. Disable IP storage, GeoIP and person
profiles, and require 90-day server-side retention before configuring the release key.

Network work belongs to a detached process with a 750 ms absolute deadline. Events
are best effort with no retries or flush delay. Command results never depend on capture.
Keyless builds retain local inspection and consent controls but cannot send. The exact
contract and deployment requirements are in [telemetry.md](../telemetry.md).
