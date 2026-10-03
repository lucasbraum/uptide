/**
 * Canonical symbol paths. The grammar lives in docs/architecture.md; this module is the
 * only place that knows how to build and split one, so adapters cannot drift from it.
 *
 *   scope?  ::= '"' specifier '"' ':'
 *   path    ::= scope? segment ( ('.' | '#') segment | '[]' )*
 *   segment ::= identifier | '"' escaped '"' | '()' | 'new()' | '[' key-type ']'
 */

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

function segment(name: string): string {
  return IDENTIFIER.test(name) ? name : JSON.stringify(name);
}

/** A symbol reachable statically: namespace members, static class members, enum members, nested types. */
export function staticMember(parent: string, name: string): string {
  return `${parent}.${segment(name)}`;
}

/** A symbol reachable on an instance: class instance members, interface and object-type members. */
export function instanceMember(parent: string, name: string): string {
  return `${parent}#${segment(name)}`;
}

/** The element type of an array-typed property, when it is an anonymous object type. */
export function element(parent: string): string {
  return `${parent}[]`;
}

export function indexSignature(parent: string, keyType: string): string {
  return `${parent}#[${keyType}]`;
}

export function callSignature(parent: string): string {
  return `${parent}#()`;
}

/** Class constructors and construct signatures: `new X()` is static-side usage. */
export function constructSignature(parent: string): string {
  return `${parent}.new()`;
}

/** Prefix for symbols that live outside the package root: foreign module augmentations, or subpath collisions. */
export function scoped(specifier: string, path: string): string {
  return `${JSON.stringify(specifier)}:${path}`;
}

export function topLevel(name: string): string {
  return segment(name);
}

/**
 * Split a path into its scope and segments, in order. Separators are attached to the
 * segment they precede so the path can be rebuilt exactly with `join`.
 */
export function splitPath(path: string): { scope?: string; segments: string[] } {
  let i = 0;
  let scope: string | undefined;
  const readQuoted = (): string => {
    // JSON string literal: starts at path[i] === '"'.
    let j = i + 1;
    while (j < path.length) {
      if (path[j] === '\\') j += 2;
      else if (path[j] === '"') break;
      else j++;
    }
    const raw = path.slice(i, j + 1);
    i = j + 1;
    return raw;
  };
  if (path[0] === '"') {
    const quoted = readQuoted();
    if (path[i] === ':') {
      scope = JSON.parse(quoted) as string;
      i++;
    } else {
      i = 0;
    }
  }
  const segments: string[] = [];
  let current = '';
  while (i < path.length) {
    const ch = path[i] as string;
    if (ch === '"') {
      current += readQuoted();
      continue;
    }
    if ((ch === '.' || ch === '#') && current !== '') {
      segments.push(current);
      current = ch;
      i++;
      continue;
    }
    if (ch === '[' && path[i + 1] === ']' && current !== '') {
      segments.push(current);
      current = '[]';
      i += 2;
      continue;
    }
    current += ch;
    i++;
  }
  if (current !== '') segments.push(current);
  return scope === undefined ? { segments } : { scope, segments };
}

export function joinPath(parts: { scope?: string; segments: string[] }): string {
  const body = parts.segments.join('');
  return parts.scope === undefined ? body : `${JSON.stringify(parts.scope)}:${body}`;
}

/** The containing symbol's path, or undefined for a top-level symbol. */
export function parentOf(path: string): string | undefined {
  const parts = splitPath(path);
  if (parts.segments.length <= 1) return undefined;
  return joinPath({ ...parts, segments: parts.segments.slice(0, -1) });
}

/** The last segment without its separator, unquoted. `[]`, `()`, `new()` and `[key]` are returned as-is. */
export function leafOf(path: string): string {
  const { segments } = splitPath(path);
  const last = segments[segments.length - 1] ?? '';
  const raw = last.startsWith('.') || last.startsWith('#') ? last.slice(1) : last;
  return raw.startsWith('"') ? (JSON.parse(raw) as string) : raw;
}
