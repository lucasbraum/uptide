export type DependencySource =
  | { kind: 'registry'; name: string; range: string }
  | { kind: 'non-registry'; source: string }
  | { kind: 'invalid' };

/** Inspect declarations, not lockfile URLs (registry downloads also use HTTP tarballs).
 * Return only source labels; private Git URLs and local paths must not enter reports. */
export function dependencySource(name: string, value: unknown): DependencySource {
  if (typeof value !== 'string') return { kind: 'invalid' };
  let spec = value.trim();
  let registryName = name;
  for (;;) {
    if (spec.startsWith('npm:')) {
      spec = spec.slice(4);
      const direct = nonRegistrySource(spec);
      if (direct) return { kind: 'non-registry', source: direct };
      const alias = /^(@[\w.-]+\/[\w.-]+|[\w.-]+)(?:@(.*))?$/.exec(spec);
      if (!alias) return { kind: 'invalid' };
      registryName = alias[1] as string;
      spec = alias[2] ?? '*';
      continue;
    }
    const source = nonRegistrySource(spec);
    if (source) return { kind: 'non-registry', source };
    // Unrecognized protocols are not registry package versions or dist-tags.
    if (spec.includes(':') || spec.includes('/')) return { kind: 'invalid' };
    return { kind: 'registry', name: registryName, range: spec };
  }
}

function nonRegistrySource(spec: string): string | undefined {
  const protocol = /^([a-z][a-z\d+.-]*):/i.exec(spec)?.[1]?.toLowerCase();
  if (protocol?.startsWith('git+') || protocol === 'git' || protocol === 'ssh') return 'git';
  if (
    protocol &&
    ['github', 'gitlab', 'bitbucket', 'file', 'link', 'workspace', 'http', 'https'].includes(
      protocol,
    )
  )
    return protocol;
  if (/^git@[^:]+:/.test(spec)) return 'git';
  if (
    /^(?:\.{1,2}[/\\]|~[/\\]|[/\\]|[a-z]:[/\\])/i.test(spec) ||
    (!/[@:]/.test(spec) && /\.(?:tgz|tar\.gz)$/.test(spec))
  )
    return 'file';
  if (/^[\w.-]+\/[\w.-]+(?:#.*)?$/.test(spec)) return 'github';
  return undefined;
}
