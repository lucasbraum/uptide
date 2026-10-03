# 0007: Direction is resolved at usage time, not at diff time

Status: accepted (2026-09-28)

## Context

Whether a widened type breaks a consumer depends on which side of the contract the
consumer is on. A property the consumer reads is broken by a wider type; one it writes
is not. A parameter of a function the consumer calls is safe to widen; the same parameter
on a callback the consumer implements is not. The diff engine sees only the package and
cannot know.

## Decision

Milestone 1 leaves such verdicts as `widened` / `narrowed` with reduced confidence and a
note. Milestone 2's `match` resolves them from `Usage.access` through a fixed table
(`resolveDirection`, one test per row): `read`/`typeRef` consume the value, `write` and
call arguments supply it, `implement` flips the parameter rules. `Finding.severity` carries
the resolved verdict and `Finding.reason` says why; `Finding.change.severity` keeps the
package-level one.

## Consequences

- The same change yields different findings at different call sites, which is the point.
- Object-literal members typed by the package are classified by what fills them: a
  function is `implement`, anything else `write`. A callback parameter that is read inside
  the callback is a `read`.
- Direction only refines what the diff produced; a `removed` symbol is breaking at every
  usage, including usages of its members.
