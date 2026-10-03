# Assignability over text

Status: accepted (2026-09-27)

## Context

Comparing normalized signature text finds every difference, including ones no consumer
can observe: `AbortSignal` becoming a structural subset, a parameter widened to a union
that still contains the old type, `AxiosPromise` versus `Promise<AxiosResponse<T>>`, a
callback whose parameter gained a field. The axios eval had four such false positives in
36 breaking changes.

## Decision

`diffPackage` keeps the textual diff as the candidate list, then asks the language adapter
to relate the types behind each changed path with the type checker (`isTypeAssignableTo`,
TypeScript ≥ 5.4). Equivalent both ways is no change; old assignable to new is `widened`;
new assignable to old is `narrowed`; neither is `type` (incompatible). Severity follows who
supplies the value:

- **Callers** supply arguments and receive returns: a widened parameter is additive
  (confidence 0.8), a narrowed one breaking; a narrowed return is additive, a widened one
  breaking.
- **Implementers** of a function-typed property (callbacks) are the mirror image: a
  widened parameter is breaking, a narrowed one additive at 0.6.
- **Outputs** (readonly properties, variables, enum members, class instances): narrowed
  additive, widened breaking.
- **Unknown direction** (mutable interface properties, type aliases): widened additive at
  0.6 with "breaking if the member is read by the consumer", narrowed breaking at 0.7.
  Milestone 2 promotes these once it sees how the consumer uses the member.

Paths the checker cannot resolve keep their textual verdict.

### Both signatures are evaluated in version B's scope

The first implementation loaded both versions into one program and compared A's actual
types with B's. That cascades: one changed type (`Config`) makes every signature that
mentions it incompatible, which is the same cascade the textual "expand nothing" rule
exists to avoid. It also merges two versions' `declare module 'stripe'` blocks into one
ambient module, which cannot work.

What a consumer experiences after upgrading is different: every name in their code
re-binds to B's declaration. So the compat program loads only B, imports B's exports as
bare names, and declares the OLD signature text and the NEW signature text as two type
aliases in that scope. `Adapter` in the old text means B's `Adapter`; the question becomes
"does the old shape, spelled with today's types, still fit the new one", which is the
question the consumer's compiler will ask.

## Consequences

- Names the old text used that B no longer exports make the alias unresolvable; those
  paths fall back to text and are usually genuinely breaking anyway.
- Container headers (`class<T> extends X`) are not type expressions and stay textual;
  their members are compared individually.
- Generic overload sets are compared as whole function types, where method bivariance can
  hide a narrowed parameter. Non-generic signatures are compared parameter by parameter.
- Package directories now stay on disk for the duration of a diff, even when both surfaces
  come from the cache, and `diffPackage` accepts `assignability: false` to skip the step.
