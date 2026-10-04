import { readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { Node, Project, SyntaxKind } from 'ts-morph';
import type { ProgressListener } from '../domain/progress.js';
import { ACCEPTED_KEYS } from '../llm/config.js';
import { CostLimitError, DEFAULT_MAX_COST_USD } from '../llm/fixer.js';
import { nanos } from '../llm/pricing.js';
import type { MigrationPack, PackContext } from '../packs/types.js';
import { applyFilePatch } from './patch.js';
import { git } from './process.js';
import { siteKey } from './report.js';
import type { AssistedAttempt, FixDiagnostic, Fixer, FixReport, FixSite } from './types.js';
import { newDiagnostics } from './verify.js';

/** Lines of using statements shown with an import site. */
const IMPORT_USE_LINES = 160;

export function enclosingContext(
  source: string,
  line: number,
  column: number,
  /** Modules whose import lines the patch may need to touch, beyond the dependency's own. */
  modules: string[] = [],
): string {
  const file = new Project({ useInMemoryFileSystem: true }).createSourceFile('context.ts', source);
  const offset =
    source
      .split('\n')
      .slice(0, line - 1)
      .reduce((n, s) => n + s.length + 1, 0) +
    column -
    1;
  const node = file.getDescendantAtPos(Math.min(offset, source.length - 1));
  const container =
    node?.getFirstAncestor(
      (n) =>
        Node.isFunctionDeclaration(n) ||
        Node.isMethodDeclaration(n) ||
        Node.isConstructorDeclaration(n) ||
        Node.isArrowFunction(n) ||
        Node.isFunctionExpression(n),
    ) ??
    node?.getFirstAncestor(
      (n) =>
        Node.isImportDeclaration(n) ||
        Node.isTypeAliasDeclaration(n) ||
        Node.isVariableStatement(n),
    ) ??
    node;
  const pieces = new Map<number, string>();
  const add = (n: Node) => {
    const start = n.getStartLineNumber(),
      end = n.getEndLineNumber();
    pieces.set(
      start,
      `Lines ${start}-${end}:\n${source
        .split('\n')
        .slice(start - 1, end)
        .join('\n')}`,
    );
  };
  if (container) add(container);
  // An import that no longer exists is fixed where the name is used, not on the import
  // line: the statements that use what this import brings in are part of the site.
  if (container && Node.isImportDeclaration(container)) {
    const names = new Set(
      [
        container.getDefaultImport(),
        container.getNamespaceImport(),
        ...container.getNamedImports().map((n) => n.getAliasNode() ?? n.getNameNode()),
      ]
        .filter((n) => n !== undefined)
        .map((n) => n.getText()),
    );
    let lines = 0;
    for (const statement of file.getStatements()) {
      if (Node.isImportDeclaration(statement)) continue;
      const uses = statement
        .getDescendantsOfKind(SyntaxKind.Identifier)
        .some((id) => names.has(id.getText()));
      if (!uses) continue;
      lines += statement.getEndLineNumber() - statement.getStartLineNumber() + 1;
      // Enough to see how the name is used; a whole large module is not the site.
      if (lines > IMPORT_USE_LINES) break;
      add(statement);
    }
  }
  // Imported dependency types and their declaration sites explain downstream generic errors.
  for (const imp of file.getImportDeclarations())
    if (['zod', 'stripe', ...modules].includes(imp.getModuleSpecifierValue())) add(imp);
  for (const ctor of file.getDescendantsOfKind(SyntaxKind.Constructor))
    if (/ZodType/.test(ctor.getText())) add(ctor);
  for (const fn of file.getFunctions())
    if (['subscriptionPeriod', 'subscriptionPeriodEnd'].includes(fn.getName() ?? '')) add(fn);
  return [...pieces]
    .sort((a, b) => a[0] - b[0])
    .map(([, text]) => text)
    .join('\n\n');
}
export async function assist(
  root: string,
  sites: FixSite[],
  pack: MigrationPack,
  fixer: Fixer | undefined,
  verify: () => FixDiagnostic[],
  context?: PackContext,
  disabled = false,
  onProgress?: ProgressListener,
  limits: { maxCostUsd?: number | undefined } = {},
): Promise<FixReport['llm']> {
  const llm: FixReport['llm'] = {
    available: !!fixer,
    ...(disabled ? { disabled: true } : {}),
    ...(fixer ? { model: fixer.id, ...(fixer.provider ? { provider: fixer.provider } : {}) } : {}),
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
  };
  const limit = limits.maxCostUsd ?? DEFAULT_MAX_COST_USD;
  let halted = false;
  const stopForBudget = (site: FixSite, reason: string) => {
    llm.costLimit ??= { limitUsd: limit, notAttempted: 0 };
    llm.costLimit.notAttempted++;
    site.reason += `; stopped before calling: ${reason} (--max-cost $${limit.toFixed(2)})`;
  };
  for (const site of [...sites].sort(
    (a, b) =>
      a.finding.usage.file.localeCompare(b.finding.usage.file) ||
      a.finding.usage.line - b.finding.usage.line,
  )) {
    if (site.outcome !== 'manual') continue;
    if (!fixer) {
      site.reason += disabled
        ? '; assisted fixes disabled (--no-llm), left manual'
        : `; no LLM API key (${ACCEPTED_KEYS}), left manual`;
      continue;
    }
    const file = join(root, site.finding.usage.file);
    const original = readFileSync(file, 'utf8');
    const before = verify();
    const candidates = before
      .filter(
        (d) =>
          d.file === site.finding.usage.file &&
          (site.finding.usage.compileCode === undefined ||
            d.code === site.finding.usage.compileCode) &&
          (d.line === site.finding.usage.line ||
            d.message === site.finding.usage.compileError ||
            (site.finding.usage.snippet.trim() !== '' &&
              original.split('\n')[d.line - 1]?.trim() === site.finding.usage.snippet.trim())),
      )
      .sort(
        (a, b) =>
          Math.abs(a.line - site.finding.usage.line) - Math.abs(b.line - site.finding.usage.line),
      );
    const diagnostic = candidates[0];
    if (!diagnostic) {
      const parent = sites.find(
        (other) =>
          other.outcome === 'agent' &&
          !other.resolvedBy &&
          other.attempts?.some((a) => a.outcome === 'accepted') &&
          other.finding.usage.file === site.finding.usage.file,
      );
      if (parent) {
        site.outcome = 'agent';
        site.reason = 'diagnostic resolved by an earlier accepted edit in this file';
        site.resolvedBy = siteKey(parent);
        site.rule = parent.rule;
      } else site.reason += '; no remaining compiler diagnostic to validate an assisted edit';
      continue;
    }
    let retry: string | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      const request = {
        finding: site.finding,
        guide: pack.guide(site.finding, context),
        // The import the site must extend is shown exactly: a shared helper's module.
        enclosingFunction: enclosingContext(
          original,
          diagnostic.line,
          diagnostic.column,
          (context?.helpers ?? []).flatMap((h) => Object.values(h.specifiers)),
        ),
        source: original,
        compilerError: `${diagnostic.file}:${diagnostic.line}:${diagnostic.column} TS${diagnostic.code}: ${diagnostic.message}${diagnostic.expected ? `\nExpected type: ${diagnostic.expected}` : ''}`,
        ...(retry ? { retry } : {}),
      };
      const remaining =
        (Math.floor(limit * 1e9) - nanos(llm.costUsd) - nanos(llm.unreportedCostUsd ?? 0)) / 1e9;
      const reservation = fixer.estimate?.(request);
      if (
        halted ||
        reservation === undefined ||
        !Number.isFinite(reservation) ||
        reservation < 0 ||
        nanos(reservation) > Math.floor(remaining * 1e9)
      ) {
        stopForBudget(
          site,
          halted
            ? 'provider accounting cannot be trusted'
            : reservation === undefined
              ? 'fixer supplied no worst-case estimate'
              : `next call needs $${reservation.toFixed(6)}, remaining $${Math.max(0, remaining).toFixed(6)}`,
        );
        break;
      }
      const where = `${site.finding.usage.file}:${site.finding.usage.line}${attempt ? ` (attempt ${attempt + 1})` : ''}`;
      const started = performance.now();
      onProgress?.({ phase: 'assist', package: pack.name, detail: where, state: 'start' });
      const log: AssistedAttempt = {
        attempt: attempt + 1,
        outcome: 'reverted',
        before,
        after: before,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        explanation: '',
      };
      site.attempts ??= [];
      site.attempts.push(log);
      try {
        const response = await fixer.fix(request, remaining);
        log.inputTokens = response.inputTokens;
        log.outputTokens = response.outputTokens;
        log.costUsd = response.costUsd ?? 0;
        log.explanation = response.explanation ?? '';
        log.diff = response.diff;
        llm.inputTokens += response.inputTokens;
        llm.outputTokens += response.outputTokens;
        llm.costUsd = (nanos(llm.costUsd) + nanos(response.costUsd ?? 0)) / 1e9;
        if (response.unreportedCostUsd)
          llm.unreportedCostUsd =
            (nanos(llm.unreportedCostUsd ?? 0) + nanos(response.unreportedCostUsd)) / 1e9;
        if (response.halt) halted = true;
        if (response.failure) throw new Error(response.failure);
        const patched = applyFilePatch(original, site.finding.usage.file, response.diff);
        const objection = pack.validateAssisted?.(
          patched,
          site.finding,
          response.explanation ?? '',
          original,
          context,
        );
        if (objection) throw new Error(objection);
        writeFileSync(file, patched);
        const after = verify();
        log.after = after;
        const newErrors = newDiagnostics(before, after);
        const same = (d: FixDiagnostic) =>
          d.file === diagnostic.file &&
          d.code === diagnostic.code &&
          d.message === diagnostic.message;
        const removed = after.filter(same).length < before.filter(same).length;
        if (removed && newErrors.length === 0) {
          log.outcome = 'accepted';
          site.outcome = 'agent';
          site.diff = response.diff;
          site.reason = `${fixer.id}: removed TS${diagnostic.code}; no new diagnostics. ${log.explanation}`;
          git(root, 'add', '--', relative(root, file));
          git(
            root,
            'commit',
            '-m',
            `fix(${pack.name}): migrate ${site.finding.usage.file}:${site.finding.usage.line}`,
          );
          break;
        }
        retry = JSON.stringify({
          removed,
          newErrors: newErrors.map((d) => `${d.file}:${d.line} TS${d.code} ${d.message}`),
        });
      } catch (e) {
        if (e instanceof CostLimitError) {
          stopForBudget(site, e.message);
          break;
        }
        retry = e instanceof Error ? e.message : String(e);
      } finally {
        if (site.outcome !== 'agent') {
          writeFileSync(file, original);
          log.explanation = [log.explanation, retry].filter(Boolean).join('; ');
        }
        onProgress?.({
          phase: 'assist',
          package: pack.name,
          detail: where,
          state: 'done',
          ms: performance.now() - started,
        });
      }
      site.reason = `assisted attempt ${attempt + 1}/3 rejected: ${log.explanation}`;
    }
  }
  return llm;
}
