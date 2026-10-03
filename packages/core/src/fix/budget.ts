/**
 * A document assembled from pieces, some of which may give way when it must fit a size:
 * GitHub refuses a PR body over 65,536 characters. A piece is dropped whole (replaced by its
 * `alt`, usually one line saying where the content is), a list loses items from its end and
 * says how many; nothing is ever cut inside a block, so no `<details>` or code fence is left
 * open. Lower ranks are kept first; rank 0 is never dropped.
 */
export type Piece =
  | { kind: 'text'; text: string; rank: number; alt?: string }
  | {
      kind: 'list';
      /** Lines before and after the items, written only when at least one item is shown. */
      open: string;
      close: string;
      items: string[];
      rank: number;
      /** The line that stands for the items left out; `{n}` is their number. */
      more: string;
    };

export const must = (text: string): Piece => ({ kind: 'text', text, rank: 0 });

export function fitPieces(pieces: Piece[], budget?: number): string {
  if (budget === undefined) return pieces.map((p) => full(p)).join('\n');
  // What each piece contributes at minimum: a text's alt, a list's "all hidden" line.
  const floor = (p: Piece): string =>
    p.kind === 'text'
      ? p.rank === 0
        ? p.text
        : (p.alt ?? '')
      : p.items.length
        ? p.more.replace('{n}', String(p.items.length))
        : '';
  const chosen = pieces.map(floor);
  let size = chosen.reduce((n, text) => n + text.length + 1, 0);
  const order = pieces
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => p.rank > 0)
    .sort((a, b) => a.p.rank - b.p.rank || a.i - b.i);
  for (const { p, i } of order) {
    const before = (chosen[i] as string).length;
    if (p.kind === 'text') {
      if (size - before + p.text.length <= budget) {
        size += p.text.length - before;
        chosen[i] = p.text;
      }
      continue;
    }
    // As many items as fit, from the top: the list is already in the order that matters.
    let shown = 0;
    let best = chosen[i] as string;
    for (let n = 1; n <= p.items.length; n++) {
      const hidden = p.items.length - n;
      const text = [
        p.open,
        ...p.items.slice(0, n),
        ...(hidden ? [p.more.replace('{n}', String(hidden))] : []),
        p.close,
      ].join('\n');
      if (size - before + text.length > budget) break;
      shown = n;
      best = text;
    }
    if (shown > 0) {
      size += best.length - before;
      chosen[i] = best;
    }
  }
  return chosen.filter((text, i) => text !== '' || pieces[i]?.rank === 0).join('\n');
}

function full(p: Piece): string {
  return p.kind === 'text' ? p.text : [p.open, ...p.items, p.close].join('\n');
}
