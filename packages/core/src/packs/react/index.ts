import { definePack, replaceAtSite } from '../contract.js';

/**
 * react >=18 <19 → >=19 <20. Every rule and note says where it comes from (`meta.sources`),
 * has a fixture in `fixtures/`, and is scored against `ground-truth.json` by
 * `uptide pack test react`. See docs/packs.md.
 */
export const reactPack = definePack({
  meta: {
    package: 'react',
    from: '>=18 <19',
    to: '>=19 <20',
    // The changelog or migration guide every rule below is taken from.
    sources: [{ title: 'react on npm', url: 'https://www.npmjs.com/package/react' }],
    maintainer: '@uptide-dev',
  },
  rules: [
    {
      // An example to replace: an export renamed between the two majors.
      id: 'example-rename',
      summary: 'oldName was renamed newName',
      severity: 'breaking',
      // The findings `check` reports for it: the type diff sees `oldName` removed.
      kinds: ['removed', 'renamed'],
      symbols: /^oldName$/,
      guide: 'oldName was renamed newName, with the same arguments and result.',
      rewrite: (text, finding) => replaceAtSite(text, finding, 'oldName', 'newName'),
    },
  ],
  behavior: [],
  instructions: 'Migrate only the reported site, from the compiler error and the guide above.',
});
