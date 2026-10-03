/** Single-file diff; removed/context text must match exactly. Header arithmetic is not trusted. */
export function applyFilePatch(source: string, file: string, patch: string): string {
  if (patch.length > 1_000_000) throw new Error('patch exceeds 1 MB');
  const lines = patch
    .trimEnd()
    .replace(/^```(?:diff)?\s*\n/, '')
    .replace(/\n```\s*$/, '')
    .split('\n');
  if (lines[0]?.startsWith('diff --git ')) lines.shift();
  if (lines[0]?.startsWith('index ')) lines.shift();
  if (lines.shift() !== `--- a/${file}` || lines.shift() !== `+++ b/${file}`)
    throw new Error('patch must modify exactly the reported file');
  const original = source.split('\n'),
    output: string[] = [];
  let cursor = 0,
    hunks = 0;
  while (lines.length) {
    const header = lines.shift();
    const h = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,(\d+))? @@.*$/.exec(header ?? '');
    if (!h) throw new Error('invalid hunk or additional file in patch');
    const declared = { old: Number(h[2] ?? 1), next: Number(h[3] ?? 1) };
    const body: string[] = [];
    while (lines.length && !lines[0]?.startsWith('@@')) body.push(lines.shift() ?? '');
    const old: string[] = [],
      next: string[] = [];
    // A model that writes the diff inside a JSON string sometimes escapes the quotes a second
    // time (`\"now\"`); the source has plain quotes, so that is what the lines mean.
    const unescaped = body.map((raw) =>
      raw.includes('\\"') && !source.includes('\\"') ? raw.replaceAll('\\"', '"') : raw,
    );
    // Only `+` lines, under a header that says nothing grew: the one added line replaces the
    // context line right above it (the model forgot its `-` line). Applied as written the
    // line would be there twice (an object literal with the same key). With one `+` line
    // the meaning is clear and the context line is taken as the replaced one; with more,
    // the hunk is refused with the reason, which the retry feeds back.
    const added = unescaped.filter((l) => l.startsWith('+')).length;
    const removedLines = unescaped.filter((l) => l.startsWith('-')).length;
    if (added > 0 && removedLines === 0 && declared.next === declared.old) {
      const at = unescaped.findIndex((l) => l.startsWith('+'));
      const above = unescaped[at - 1];
      if (added === 1 && above !== undefined && (above === '' || above.startsWith(' ')))
        unescaped[at - 1] = `-${above.slice(1)}`;
      else
        throw new Error(
          `hunk at line ${h[1]} adds ${added} lines with no \`-\` line, yet its header says the length is unchanged: a replaced line needs its \`-\` line before the \`+\` line`,
        );
    }
    // Which entries of old/next are blank context lines: a model shown code with its pieces
    // separated by blank lines reproduces them as context where the file has none.
    const blankContext: { old: number; next: number }[] = [];
    for (const raw of unescaped) {
      if (raw.startsWith('--- ') || raw.startsWith('+++ ') || raw.startsWith('diff --git'))
        throw new Error('additional file in patch');
      const line = raw === '' ? ' ' : raw,
        mode = line[0],
        content = line.slice(1);
      if (![' ', '-', '+'].includes(mode ?? '')) throw new Error(`invalid patch line: ${line}`);
      if (mode === ' ' && content.trim() === '')
        blankContext.push({ old: old.length, next: next.length });
      if (mode === ' ' || mode === '-') old.push(content);
      if (mode === ' ' || mode === '+') next.push(content);
      if (
        mode === '+' &&
        /@ts-(?:ignore|nocheck|expect-error)|\bas\s+any\b|\bas\s+unknown\s+as\b/.test(content)
      )
        throw new Error('diagnostic suppression is not a migration');
    }
    let start = Number(h[1]) - 1;
    const matching = (o: string[]) => (i: number) =>
      i >= cursor && i <= original.length && o.every((line, n) => original[i + n] === line);
    let [o, n] = [old, next];
    let matches = matching(o);
    if (!matches(start) && blankContext.length) {
      // The same hunk without its blank context lines; a real match wins over the exact one.
      const without = (list: string[], at: number[]) => list.filter((_, i) => !at.includes(i));
      const [oc, nc] = [
        without(
          old,
          blankContext.map((b) => b.old),
        ),
        without(
          next,
          blankContext.map((b) => b.next),
        ),
      ];
      if (matching(oc)(start) || original.map((_, i) => i).filter(matching(oc)).length === 1) {
        [o, n] = [oc, nc];
        matches = matching(o);
      }
    }
    if (!matches(start)) {
      // Only a unique, byte-exact block may repair an LLM's inaccurate line number.
      const candidates = o.length ? original.map((_, i) => i).filter(matches) : [];
      if (candidates.length !== 1)
        throw new Error(
          `patch context does not match uniquely (hunk at line ${start + 1}); preserve exact source text and use minimal hunks`,
        );
      start = candidates[0] as number;
    }
    output.push(...original.slice(cursor, start), ...n);
    cursor = start + o.length;
    hunks++;
  }
  if (!hunks) throw new Error('empty patch');
  output.push(...original.slice(cursor));
  return output.join('\n');
}
