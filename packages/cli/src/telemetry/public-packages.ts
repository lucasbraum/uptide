import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { defaultCacheDir } from '@uptide/core';
import { NAME_PATTERN as NAME, type PublicVersion, VERSION_PATTERN as VERSION } from './payload.js';

/** No extra registry requests, and never assume an authenticated/custom-registry result is public. */
export function cachedPublicVersion(env: NodeJS.ProcessEnv): PublicVersion {
  return (name, version) => {
    if (!NAME.test(name) || name.length > 214 || !VERSION.test(version) || version.length > 128)
      return false;
    for (const key of [`resolve-${version}`, 'resolve-latest']) {
      try {
        const path = join(defaultCacheDir(env), 'registry', ...name.split('/'), `${key}.json`);
        if (statSync(path).size > 1024 * 1024) continue;
        const { value } = JSON.parse(readFileSync(path, 'utf8'));
        if (value.publicRegistry === true && value.name === name && value.version === version)
          return true;
      } catch {
        /* No trustworthy evidence: omit, without querying a name that could be private. */
      }
    }
    return false;
  };
}
