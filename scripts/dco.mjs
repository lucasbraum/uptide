// Whether every commit a pull request adds carries a Developer Certificate of Origin
// sign-off (https://developercertificate.org/), which is how a contributor states they
// have the right to send the patch under the project's license.
//
//   node scripts/dco.mjs <base-ref> <head-ref> [--base-name=<name>] [--pr-author=<login>] [--json]
//
// The range is everything on `head` since it left `base`, so a long-running branch is not
// asked to account for commits it merely inherited. CI passes the refs it fetched for
// itself, which are not names a contributor could rebase onto, so `--base-name` sets what
// the failure message tells them to use.
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BOTS } from './bots.mjs';

/**
 * Bots that cannot sign off, by login, with the noreply address GitHub gives each
 * (scripts/bots.mjs). A commit is exempt only when the pull request was opened by that bot
 * (`--pr-author`, which GitHub sets and a contributor cannot) and the commit is authored by
 * that same bot: an author address is just text in a commit, so on its own it would let
 * anyone skip the sign-off.
 */
export { BOTS };

/** The commits a bot's own pull request carries in its own name. */
export function exempt(list, prAuthor) {
  const bot = Object.hasOwn(BOTS, prAuthor ?? '') ? BOTS[prAuthor] : undefined;
  if (!bot) return [];
  const own = (email) => (bot instanceof RegExp ? bot.test(email) : email === bot);
  return list.filter((c) => own(c.email.toLowerCase()));
}

/** A sign-off line: a name, then an address in angle brackets, as `git commit -s` writes. */
const SIGN_OFF = /^[ \t]*Signed-off-by:[ \t]*(\S.*?)[ \t]*<([^<>\s]+@[^<>\s]+)>[ \t]*$/gim;

const git = (args, cwd) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

/** The commit `head` adds on top of `base`: oldest first, merge commits included. */
export function commits(base, head, cwd = process.cwd()) {
  // A pull request's base branch moves on. What the branch added is measured from where it
  // forked off, which is the merge base, not wherever the base branch has since got to.
  const from = git(['merge-base', base, head], cwd).trim();
  // One record per commit, with field and record separators no commit message can contain.
  const log = git(
    ['log', '--reverse', '--format=%H%x1f%ae%x1f%s%x1f%B%x1e', `${from}..${head}`],
    cwd,
  );
  return log
    .split('\x1e')
    .map((record) => record.replace(/^\n/, ''))
    .filter(Boolean)
    .map((record) => {
      const [sha, email, subject, message] = record.split('\x1f');
      return { sha, email, subject, message };
    });
}

/**
 * Everything missing, as sentences. A sign-off has to be the commit author's own: a line
 * naming somebody else certifies nothing about the person who wrote the patch.
 */
export function problems(list, prAuthor) {
  const found = [];
  const skip = new Set(exempt(list, prAuthor));
  for (const commit of list) {
    if (skip.has(commit)) continue;
    const { sha, email, subject, message } = commit;
    const short = sha.slice(0, 8);
    const signers = [...message.matchAll(SIGN_OFF)].map((match) => match[2].toLowerCase());
    if (!signers.length) found.push(`${short} has no Signed-off-by line: ${subject}`);
    else if (!signers.includes(email.toLowerCase()))
      found.push(
        `${short} is signed off by ${signers.join(', ')} but authored by ${email}: ${subject}`,
      );
  }
  return found;
}

/** What to run to fix it, naming the branch this pull request is against. */
export function howToFix(base) {
  return [
    'Every commit in a pull request needs a Developer Certificate of Origin sign-off.',
    'Add it to the commits you already pushed, then force-push the branch:',
    '',
    `  git rebase --signoff ${base}`,
    '  git push --force-with-lease',
    '',
    'A merge commit needs one too (`git merge --signoff`); rebasing avoids them entirely.',
    'New commits get the line from `git commit -s`. See CONTRIBUTING.md.',
  ].join('\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const [base, head] = args.filter((arg) => !arg.startsWith('--'));
  if (!base || !head) {
    console.error(
      'usage: node scripts/dco.mjs <base-ref> <head-ref> [--base-name=<name>] [--pr-author=<login>] [--json]',
    );
    process.exit(2);
  }
  const list = commits(base, head);
  const prAuthor = args.find((arg) => arg.startsWith('--pr-author='))?.slice(12);
  const bots = exempt(list, prAuthor);
  const found = problems(list, prAuthor);
  // The ref CI fetched is not a name anyone can rebase onto; this says what to print.
  const named = args.find((arg) => arg.startsWith('--base-name='))?.slice(12) || base;
  if (args.includes('--json')) {
    console.log(
      JSON.stringify(
        { commits: list.map((c) => c.sha), exempt: bots.map((c) => c.sha), problems: found },
        null,
        2,
      ),
    );
  } else {
    console.log(`${list.length} commits on ${head} since ${named}`);
    for (const c of bots)
      console.log(`  · ${c.sha.slice(0, 8)} authored by ${prAuthor}, exempt: ${c.subject}`);
    for (const line of found) console.log(`  ✗ ${line}`);
    console.log(found.length ? `\n${howToFix(named)}` : 'every commit is signed off');
  }
  process.exit(found.length ? 1 : 0);
}
