import type { Importer, PackageReport } from '@uptide/core';

/**
 * What a reader must know about who imports a package: a workspace that imports it without
 * declaring it (and where its copy comes from), and any importer the analysis could not
 * cover, with the reason. Declared, analyzed importers say nothing here; `--details` lists
 * them all. Plain text; the views add their own color and indentation.
 */
export function importerNotes(p: PackageReport): string[] {
  return (p.importers ?? []).flatMap((i) => {
    const line = describeImporter(p.name, i);
    return line ? [line] : [];
  });
}

function describeImporter(name: string, i: Importer): string | undefined {
  const where = i.workspace === '.' ? 'root' : i.workspace;
  if (!i.declared) {
    const resolved = i.via ? ` (resolved via ${i.via})` : '';
    return i.analyzed
      ? `${where} · imports ${name} without declaring it${resolved}`
      : `${where} · imports ${name} without declaring it, not analyzed: ${i.reason ?? 'unknown reason'}`;
  }
  if (!i.analyzed)
    return `${where} · imports ${name}, not analyzed: ${i.reason ?? 'unknown reason'}`;
  return undefined;
}

/** `packages/core, ui (undeclared, via @acme/core), worker`: every analyzed importer. */
export function analyzedImporters(p: PackageReport): string | undefined {
  const list = (p.importers ?? []).filter((i) => i.analyzed);
  if (list.length === 0) return undefined;
  return list
    .map((i) => {
      const where = i.workspace === '.' ? 'root' : i.workspace;
      if (i.declared) return where;
      return `${where} (undeclared${i.via ? `, via ${i.via}` : ''})`;
    })
    .join(', ');
}
