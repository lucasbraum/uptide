import { stripVTControlCharacters } from 'node:util';
import pc from 'picocolors';

export const textWidth = (text: string): number =>
  Array.from(stripVTControlCharacters(text)).length;
export const ellipsis = (text: string, width: number): string => {
  const chars = Array.from(text);
  return chars.length <= width ? text : `${chars.slice(0, Math.max(0, width - 1)).join('')}…`;
};
export type Tone = 'bold' | 'dim' | 'yellow' | 'green';
export interface Cell {
  text: string;
  tone?: Tone;
  span?: 'rest';
  alignAt?: string;
}
/** Measure plain text before styling. Narrow terminals sacrifice trailing columns before wrapping. */
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
  if (lengths[0]) lengths[0] = Math.max(12, lengths[0] - Math.max(0, total() - width));
  while (total() > width && lengths.length > 2) lengths.pop();
  if (lengths[0]) lengths[0] = Math.max(1, lengths[0] - Math.max(0, total() - width));
  if (total() > width && lengths[1]) lengths[1] = Math.max(1, lengths[1] - (total() - width));
  return rows.map((row) => {
    const cells: string[] = [];
    let consumed = indent;
    for (const [i, length] of lengths.entries()) {
      const cell = row[i];
      const available = cell?.span ? width - consumed : length;
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
    return (' '.repeat(indent) + cells.join('   ')).trimEnd();
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
