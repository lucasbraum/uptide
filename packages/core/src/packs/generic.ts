import type { Finding } from '../domain/report.js';
import type { MigrationPack } from './types.js';

/** What every generic run tells its reviewer, in the report and at the top of the PR. */
export const GENERIC_NOTE = (name: string): string =>
  `No migration pack covers \`${name}\`. Every edit here was written by the agent and kept only because the compiler error at that site went away and no new one appeared: review each change carefully.`;

/**
 * The pack of a dependency that has none: no rule, no curated guide, no knowledge of the
 * package's behaviour. `fix` still runs the same loop (one site, one patch, kept only if the
 * site's compiler error disappears and no new one appears), with a guide made of what the
 * check found: the change, both declarations and the compiler's message.
 */
export function genericPack(name: string): MigrationPack {
  return {
    name,
    // Unknown here: a generic run needs the registry to say what `latest` is.
    defaultTarget: '',
    rules: [],
    supports: () => true,
    transform: (text) => ({
      text,
      applied: false,
      reason: 'no migration pack: assisted review required',
    }),
    guide: (f: Finding) =>
      [
        `Migrate this call site of ${f.change.package} from ${f.change.from} to ${f.change.to}. There is no curated guide for this package: work only from the compiler error and the change below.`,
        `Change: ${f.change.path} (${f.change.kind})${f.change.notes ? `: ${f.change.notes}` : ''}.`,
        f.change.before ? `Before: ${f.change.before}` : '',
        f.change.after ? `After: ${f.change.after}` : '',
        f.change.replacement ? `Likely replacement: ${f.change.replacement}` : '',
        // What check knows about the target: its exports, when an import went missing.
        ...(f.details ?? []),
        'Patch ONLY the reported site, with the smallest edit that makes it compile against the target and keeps what the code does. Never cast, never suppress a diagnostic, never delete the call, never change values, messages or control flow that the upgrade does not require. If the site cannot be migrated safely from what is shown, say so instead of guessing.',
      ]
        .filter(Boolean)
        .join('\n'),
    reviewNotes: () => [GENERIC_NOTE(name)],
  };
}
