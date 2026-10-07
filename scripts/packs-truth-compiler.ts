import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';

export interface Diagnostic {
  file: string;
  line: number;
  code: number;
  message: string;
}

/** Deprecated declarations, as the language service reports them to an editor. */
const DEPRECATED = new Set([6385, 6387]);

/**
 * Errors and deprecation suggestions of every program a repository's tsconfig files describe,
 * computed by the repository's own TypeScript (the one it installed), project-relative.
 */
export function compilerDiagnostics(
  project: string,
  configs: string[],
): { compiler: string; diagnostics: Diagnostic[] } {
  const require = createRequire(join(project, 'package.json'));
  let ts = require(
    require.resolve('typescript', {
      paths: [project, ...configs.map((c) => join(project, dirname(c)))],
    }),
  ) as typeof import('typescript');
  let compiler = `typescript ${ts.version}, the repository's`;
  // TypeScript 7 has no JavaScript API: the one this checkout builds with stands in, said so.
  if (typeof ts.getParsedCommandLineOfConfigFile !== 'function') {
    const own = createRequire(import.meta.url)('typescript') as typeof import('typescript');
    compiler = `typescript ${own.version}, this checkout's (the repository's ${(ts as { version?: string }).version ?? 'own'} has no JavaScript API)`;
    ts = own;
  }
  const out: Diagnostic[] = [];
  for (const config of configs) {
    const file = join(project, config);
    const parsed = ts.getParsedCommandLineOfConfigFile(
      file,
      {},
      { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} },
    );
    if (!parsed) continue;
    const service = ts.createLanguageService({
      getScriptFileNames: () => parsed.fileNames,
      getScriptVersion: () => '1',
      getScriptSnapshot: (f) =>
        ts.sys.fileExists(f) ? ts.ScriptSnapshot.fromString(ts.sys.readFile(f) ?? '') : undefined,
      getCurrentDirectory: () => dirname(file),
      getCompilationSettings: () => parsed.options,
      getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
      fileExists: ts.sys.fileExists,
      readFile: ts.sys.readFile,
      readDirectory: ts.sys.readDirectory,
      directoryExists: ts.sys.directoryExists,
      getDirectories: ts.sys.getDirectories,
      realpath: ts.sys.realpath,
    });
    for (const source of parsed.fileNames) {
      if (source.includes('/node_modules/')) continue;
      const diagnostics = [
        ...service.getSyntacticDiagnostics(source),
        ...service.getSemanticDiagnostics(source),
        ...service.getSuggestionDiagnostics(source).filter((d) => DEPRECATED.has(d.code)),
      ];
      for (const d of diagnostics) {
        if (!d.file || d.start === undefined) continue;
        if (d.category !== ts.DiagnosticCategory.Error && !DEPRECATED.has(d.code)) continue;
        out.push({
          file: relative(project, d.file.fileName),
          line: d.file.getLineAndCharacterOfPosition(d.start).line + 1,
          code: d.code,
          message: ts.flattenDiagnosticMessageText(d.messageText, ' '),
        });
      }
    }
  }
  return {
    compiler,
    diagnostics: out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line),
  };
}
