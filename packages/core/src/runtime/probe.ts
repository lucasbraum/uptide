/**
 * The script the Signal C child process runs. It is kept as source text, written into the
 * sandbox and executed by whichever Node was chosen, so it needs no build entry and works
 * the same from `dist/` and from tests. It must stay plain ESM JavaScript.
 *
 * Usage: node probe.mjs <specifier> <require|import|both>. Prints one JSON line.
 */
export const PROBE_SOURCE = `
import { createRequire } from 'node:module';

const [, , name, mode] = process.argv;
const require = createRequire(process.cwd() + '/probe.mjs');

function describe(value) {
  const kind = value === null ? 'null' : typeof value;
  const out = { ok: true, kind };
  if (kind === 'function' || kind === 'object') {
    const keys = {};
    for (const key of Object.keys(value)) {
      try { keys[key] = typeof value[key]; } catch { keys[key] = 'unknown'; }
    }
    out.keys = keys;
  }
  if (kind === 'function') {
    out.callable = true;
    out.constructable = typeof value.prototype === 'object' && value.prototype !== null;
  }
  const def = value && (kind === 'object' || kind === 'function') ? value.default : undefined;
  if (def !== undefined) {
    out.defaultKind = typeof def;
    if (typeof def === 'function') {
      out.defaultCallable = true;
      out.defaultConstructable = typeof def.prototype === 'object' && def.prototype !== null;
    }
    if (def && (typeof def === 'object' || typeof def === 'function')) {
      out.defaultKeys = Object.keys(def);
    }
  }
  return out;
}

function failure(err) {
  const message = String(err && err.message ? err.message : err);
  const missing = /Cannot find (?:module|package) '([^']+)'/.exec(message);
  const importedFrom = /imported from (\\S+)/.exec(message);
  const stack = err && Array.isArray(err.requireStack) ? err.requireStack[0] : undefined;
  return {
    ok: false,
    code: err && err.code ? String(err.code) : undefined,
    message: message.split('\\n')[0].slice(0, 300),
    missing: missing ? missing[1] : undefined,
    from: stack || (importedFrom ? importedFrom[1] : undefined),
  };
}

const result = {};
if (mode === 'require' || mode === 'both') {
  try { result.require = describe(require(name)); } catch (err) { result.require = failure(err); }
}
if (mode === 'import' || mode === 'both') {
  try { result.import = describe(await import(name)); } catch (err) { result.import = failure(err); }
}
process.stdout.write(JSON.stringify(result) + '\\n');
`;
