import { expect, it } from 'vitest';
import { fitPieces, must, type Piece } from './budget.js';

const pieces: Piece[] = [
  must('# Title'),
  { kind: 'text', text: '<details>\nlong diff\n</details>', rank: 1, alt: 'Diff: in the report.' },
  must('## Changelog'),
  {
    kind: 'list',
    open: '<details><summary>4 entries</summary>\n',
    close: '\n</details>',
    items: ['- a (breaking)', '- b (breaking)', '- c', '- d'],
    rank: 2,
    more: '- … {n} more: https://example.test/changelog',
  },
  { kind: 'text', text: '```text\ntest output\n```', rank: 3, alt: '' },
];

it('renders everything without a budget', () => {
  const out = fitPieces(pieces);
  expect(out).toContain('long diff');
  expect(out).toContain('- d\n\n</details>');
  expect(out).toContain('test output');
});

it('keeps rank 0, then lower ranks first, and never cuts inside a block', () => {
  const out = fitPieces(pieces, 172);
  expect(out.length).toBeLessThanOrEqual(172);
  expect(out).toContain('# Title');
  expect(out).toContain('long diff');
  // The list lost items from its end and says how many; the block is closed.
  expect(out).toContain('- a (breaking)');
  expect(out).toMatch(/- … \d more: https:\/\/example\.test\/changelog\n\n<\/details>/);
  expect(out).not.toContain('test output');
  expect((out.match(/<details>/g) ?? []).length).toBe((out.match(/<\/details>/g) ?? []).length);
  expect((out.match(/```/g) ?? []).length % 2).toBe(0);
});

it('falls back to one line per piece when almost nothing fits', () => {
  const out = fitPieces(pieces, 90);
  expect(out).toBe(
    [
      '# Title',
      'Diff: in the report.',
      '## Changelog',
      '- … 4 more: https://example.test/changelog',
    ].join('\n'),
  );
});
