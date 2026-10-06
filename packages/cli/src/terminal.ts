import { stripVTControlCharacters } from 'node:util';
import pc from 'picocolors';

export const textWidth = (text: string): number =>
  Array.from(stripVTControlCharacters(text)).length;
export const ellipsis = (text: string, width: number): string => {
  const chars = Array.from(text);
  return chars.length <= width ? text : `${chars.slice(0, Math.max(0, width - 1)).join('')}…`;
};
export type Tone = 'bold' | 'dim' | 'yellow' | 'green' | 'red';
export interface Cell {
  text: string;
  tone?: Tone;
  span?: 'rest';
  alignAt?: string;
}
/** Names wider than this wrap: the name alone on its line, the rest of the row under it. */
export const NAME_CAP = 45;
/**
 * Measure plain text before styling. The first column is a name and is never truncated:
 * narrow terminals sacrifice trailing columns, then shorten the second.
 */
export function alignedRows(rows: Cell[][], width: number, color: boolean, indent = 0): string[] {
  const colors = pc.createColors(color);
  rows = rows.map((row) =>
    row.map((cell, column) => {
      const marker = cell.alignAt;
      if (!marker || !cell.text.includes(marker)) return cell;
      const before = cell.text.indexOf(marker);
      const widest = Math.max(
        ...rows.map((r) => {
          const other = r[column];
          return other && other.alignAt === marker ? Math.max(0, other.text.indexOf(marker)) : 0;
        }),
      );
      return { ...cell, text: ' '.repeat(widest - before) + cell.text };
    }),
  );
  const lengths = Array.from({ length: Math.max(0, ...rows.map((r) => r.length)) }, (_, i) =>
    Math.max(0, ...rows.map((r) => textWidth(r[i]?.span ? '' : (r[i]?.text ?? '')))),
  );
  while (lengths.at(-1) === 0) lengths.pop();
  const total = (): number =>
    lengths.reduce((a, b) => a + b, 0) + Math.max(0, lengths.length - 1) * 3 + indent;
  if (lengths[0]) lengths[0] = Math.min(NAME_CAP, Math.max(12, lengths[0]));
  while (total() > width && lengths.length > 2) lengths.pop();
  if (total() > width && lengths[1]) lengths[1] = Math.max(1, lengths[1] - (total() - width));
  return rows.map((row) => {
    const cells: string[] = [];
    let consumed = indent;
    let wrapped = '';
    for (const [i, length] of lengths.entries()) {
      const cell = row[i];
      const available = cell?.span ? width - consumed : length;
      if (i === 0 && cell && textWidth(cell.text) > length) {
        // A name past the cap gets its own line; the row continues under it.
        wrapped = `${' '.repeat(indent)}${cell.tone ? colors[cell.tone](cell.text) : cell.text}\n`;
        cells.push(' '.repeat(length));
        consumed += length + 3;
        continue;
      }
      const text = ellipsis(cell?.text ?? '', Math.max(1, available));
      const styled = cell?.tone ? colors[cell.tone](text) : text;
      cells.push(
        styled +
          (cell?.span || i === lengths.length - 1
            ? ''
            : ' '.repeat(Math.max(0, length - textWidth(text)))),
      );
      consumed += length + 3;
      if (cell?.span) break;
    }
    return wrapped + (' '.repeat(indent) + cells.join('   ')).trimEnd();
  });
}
export const terminalHeader = (
  command: string,
  header: { repo: string; manager: string; ms: number },
  color: boolean,
): string => {
  const c = pc.createColors(color);
  return `${c.bold(`uptide ${command}`)} ${c.dim('·')} ${header.repo} ${c.dim('·')} ${header.manager} ${c.dim('·')} ${header.ms < 1000 ? `${Math.round(header.ms)}ms` : `${(header.ms / 1000).toFixed(header.ms < 10_000 ? 1 : 0)}s`}`;
};
