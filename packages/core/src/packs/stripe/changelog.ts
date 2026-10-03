import type { StripeTouches } from './relevance.js';
export interface StripeEntry {
  touches?: StripeTouches;
  version: string;
  title: string;
  url: string;
  products: string;
  breaking: boolean;
  category: string;
}
export interface StripeCatalog {
  schema: 1;
  source: string;
  sha256: string;
  generatedAt: string;
  versions: string[];
  entries: StripeEntry[];
}
/** Build-time parser. Version headings bound every entry; no runtime fetch. */
export function parseChangelog(markdown: string): Pick<StripeCatalog, 'versions' | 'entries'> {
  let version = '';
  const versions = new Set<string>();
  const entries = new Map<string, StripeEntry>();
  for (const line of markdown.split('\n')) {
    const header = /^## (\d{4}-\d{2}-\d{2}(?:\.[\w-]+)?)/.exec(line);
    if (header) {
      version = header[1] ?? '';
      versions.add(version);
      continue;
    }
    const row =
      /^\| \[(.+?)\]\((https:\/\/docs\.stripe\.com\/changelog\/[^)]+)\) \| (.*?) \| (Breaking|Non-breaking) \| (.*?) \|/.exec(
        line,
      );
    if (!row || !version) continue;
    const entry = {
      version,
      title: row[1] ?? '',
      url: row[2] ?? '',
      products: row[3] ?? '',
      breaking: row[4] === 'Breaking',
      category: row[5] ?? '',
    };
    entries.set(`${version}:${entry.url}`, entry);
  }
  if (versions.size === 0 || entries.size === 0)
    throw new Error('Stripe changelog format changed; no versioned entries parsed');
  return {
    versions: [...versions].sort(),
    entries: [...entries.values()].sort(
      (a, b) => a.version.localeCompare(b.version) || a.url.localeCompare(b.url),
    ),
  };
}
export function between(catalog: StripeCatalog, from: string, to: string): StripeEntry[] {
  // Preview releases are a different API track. Stable SDK upgrades do not opt into them.
  const preview = from.endsWith('.preview') || to.endsWith('.preview');
  if (from > to) throw new Error('Stripe API downgrades are not supported');
  if (!catalog.versions.includes(to))
    throw new Error(
      `Stripe API ${to} is absent from the checked-in changelog; regenerate it before publishing`,
    );
  return catalog.entries.filter(
    (e) => e.version > from && e.version <= to && (preview || !e.version.endsWith('.preview')),
  );
}
