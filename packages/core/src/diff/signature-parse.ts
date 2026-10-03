/**
 * Just enough parsing of normalized signature text to tell widening from narrowing.
 * Signatures come from the TypeScript printer, so spacing is canonical. Anything this
 * cannot parse is treated as an opaque string by the caller, never guessed at.
 */

const OPEN = new Set(['(', '[', '{', '<']);
const CLOSE = new Set([')', ']', '}', '>']);

/** Splits at `sep` occurrences that are outside brackets and string literals. */
export function splitTopLevel(text: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | undefined;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if (OPEN.has(ch)) depth++;
    else if (CLOSE.has(ch)) depth--;
    else if (ch === sep[0] && depth === 0 && text.startsWith(sep, i)) {
      parts.push(text.slice(start, i).trim());
      start = i + sep.length;
      i = start - 1;
    }
  }
  parts.push(text.slice(start).trim());
  return parts.filter((p) => p !== '');
}

/** `=>` arrow types confuse a naive `>` count; the splitter above treats `>` as a close, so guard callers. */
export function unionMembers(type: string): string[] {
  const stripped = type.startsWith('| ') ? type.slice(2) : type;
  return splitTopLevel(stripped, '|').map((m) => m.trim());
}

export interface Param {
  name: string;
  optional: boolean;
  rest: boolean;
  type: string;
}

export interface Overload {
  typeParams: string[];
  params: Param[];
  returnType: string;
  /** Declared `this` type, kept apart from the positional parameters. */
  thisType?: string;
}

function parseParam(text: string): Param | undefined {
  const m = /^(\.\.\.)?([A-Za-z_$][\w$]*|\{[\s\S]*\}|\[[\s\S]*\])(\?)?\s*:\s*([\s\S]+)$/.exec(text);
  if (!m) {
    // Untyped parameter: `x` or `x?` (implicitly any).
    const bare = /^(\.\.\.)?([A-Za-z_$][\w$]*)(\?)?$/.exec(text);
    if (!bare) return undefined;
    return {
      name: bare[2] as string,
      optional: bare[3] === '?',
      rest: bare[1] === '...',
      type: 'any',
    };
  }
  return {
    name: m[2] as string,
    optional: m[3] === '?',
    rest: m[1] === '...',
    type: (m[4] as string).trim(),
  };
}

/** Parses one `<T>(a: A, b?: B): R` overload. Modifiers like `protected` are stripped first. */
export function parseOverload(text: string): Overload | undefined {
  let rest = text.replace(/^(protected|abstract|readonly|static)\s+/g, '').trim();
  const typeParams: string[] = [];
  if (rest.startsWith('<')) {
    const end = matchingClose(rest, 0);
    if (end === -1) return undefined;
    typeParams.push(...splitTopLevel(rest.slice(1, end), ','));
    rest = rest.slice(end + 1).trim();
  }
  if (!rest.startsWith('(')) return undefined;
  const close = matchingClose(rest, 0);
  if (close === -1) return undefined;
  const paramText = rest.slice(1, close);
  const after = rest.slice(close + 1).trim();
  // `(a): R` for declarations, `(a) => R` for function types. Anything else after the
  // parentheses (`(A & B) | C`) is a parenthesized type, not a callable.
  if (after !== '' && !after.startsWith(':') && !after.startsWith('=>')) return undefined;
  const returnType = after.startsWith(':')
    ? after.slice(1).trim()
    : after.startsWith('=>')
      ? after.slice(2).trim()
      : 'void';
  const params: Param[] = [];
  let thisType: string | undefined;
  for (const p of splitTopLevel(paramText, ',')) {
    const parsed = parseParam(p);
    if (!parsed) return undefined;
    if (parsed.name === 'this' && params.length === 0 && thisType === undefined) {
      thisType = parsed.type;
      continue;
    }
    params.push(parsed);
  }
  const overload: Overload = { typeParams, params, returnType };
  if (thisType !== undefined) overload.thisType = thisType;
  return overload;
}

function matchingClose(text: string, openIndex: number): number {
  const open = text[openIndex] as string;
  const close = open === '(' ? ')' : open === '<' ? '>' : open === '[' ? ']' : '}';
  let depth = 0;
  let quote: string | undefined;
  for (let i = openIndex; i < text.length; i++) {
    const ch = text[i] as string;
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if (ch === open) depth++;
    else if (ch === close && --depth === 0) return i;
  }
  return -1;
}

/** A callable signature is one or more overloads joined by `; `. Returns undefined if any overload fails to parse. */
export function parseCallable(signature: string): Overload[] | undefined {
  const overloads: Overload[] = [];
  for (const text of splitTopLevel(signature, ';')) {
    const parsed = parseOverload(text);
    if (!parsed) return undefined;
    overloads.push(parsed);
  }
  return overloads.length > 0 ? overloads : undefined;
}

export function looksCallable(signature: string): boolean {
  if (!/^(protected |abstract |static )*(<|\()/.test(signature)) return false;
  return parseCallable(signature.replace(/^(protected |abstract |static )+/, '')) !== undefined;
}

const LEADING_KEYWORDS = /^(readonly |protected |abstract |static |const |let |var )+/;

/**
 * The callable text inside a signature, whatever declaration carried it: `const (a) => R`,
 * `{ (a): R; (b): R }` or `protected (a): R` all become their overload list. Undefined
 * when the signature is not callable.
 */
export function asCallable(signature: string): string | undefined {
  const text = signature.replace(LEADING_KEYWORDS, '').trim();
  const inner = /^\{ (.*) \}$/.exec(text)?.[1] ?? text;
  return looksCallable(inner) ? inner : undefined;
}

/** A callable's shape with parameter names and arrow/colon spelling removed, for equality checks. */
/** First identifier of a type parameter declaration (`const T extends X = Y` -> `T`). */
export function typeParamName(declaration: string): string | undefined {
  return /^(?:const\s+)?([A-Za-z_$][\w$]*)/.exec(declaration.trim())?.[1];
}

/** Renames type parameters positionally (T0, T1, ...) inside one overload's texts. */
function renamePositional(o: Overload): Overload {
  const names = o.typeParams
    .map((tp) => typeParamName(tp))
    .filter((n): n is string => n !== undefined);
  const rename = (text: string): string =>
    names.reduce(
      (acc, name, i) =>
        acc.replace(new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\b`, 'g'), `T${i}`),
      text,
    );
  return {
    typeParams: o.typeParams.map(rename),
    params: o.params.map((p) => ({ ...p, type: rename(p.type) })),
    returnType: rename(o.returnType),
    ...(o.thisType !== undefined ? { thisType: rename(o.thisType) } : {}),
  };
}

export function callableShape(signature: string): string | undefined {
  const text = asCallable(signature);
  const overloads = text ? parseCallable(text) : undefined;
  if (!overloads) return undefined;
  return overloads
    .map(renamePositional)
    .map((o) => {
      const tp = o.typeParams.length > 0 ? `<${o.typeParams.join(', ')}>` : '';
      const params = [
        ...(o.thisType !== undefined ? [`this: ${o.thisType}`] : []),
        ...o.params.map((p) => `${p.rest ? '...' : ''}${p.type}${p.optional ? '?' : ''}`),
      ].join(', ');
      return `${tp}(${params}): ${o.returnType}`;
    })
    .join('; ');
}
