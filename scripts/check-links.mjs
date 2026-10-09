// Every relative link in the repository's Markdown resolves: the file exists, and when the
// link names a heading (`page.md#section`), that heading is in the page. Links inside fenced
// code blocks are not links. Fixtures and changelogs are left out.
//
//   node scripts/check-links.mjs
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const SKIP = /^(fixtures\/|packages\/[^/]+\/CHANGELOG\.md$|\.changeset\/|node_modules\/)/;

/** GitHub's heading anchors: lowercase, punctuation dropped, spaces to hyphens. */
export function slug(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[`*_~]/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-');
}

function withoutFences(text) {
  return text.replace(/```[\s\S]*?```/g, '');
}

function withoutCode(text) {
  return withoutFences(text).replace(/`[^`\n]*`/g, '');
}

export function headings(text) {
  const seen = new Map();
  const out = new Set();
  // A heading keeps the words inside its backticks (`uptide pack` is part of the anchor).
  for (const line of withoutFences(text).split('\n')) {
    const m = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    const base = slug(m[1]);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n === 0 ? base : `${base}-${n}`);
  }
  return out;
}

export function links(text) {
  const found = [];
  const re = /\]\(<?([^)\s>]+)>?(?:\s+"[^"]*")?\)/g;
  for (const m of withoutCode(text).matchAll(re)) found.push(m[1]);
  return found;
}

export function checkFile(file, read = (f) => readFileSync(f, 'utf8')) {
  const text = read(file);
  const problems = [];
  for (const target of links(text)) {
    if (/^(https?:|mailto:|#$)/.test(target)) continue;
    const [path, anchor] = target.split('#');
    const resolved = path ? resolve(dirname(file), decodeURIComponent(path)) : file;
    if (!existsSync(resolved)) {
      problems.push(`${target}: no such file`);
      continue;
    }
    if (anchor && /\.md$/i.test(resolved) && !statSync(resolved).isDirectory()) {
      if (!headings(read(resolved)).has(anchor.toLowerCase()))
        problems.push(`${target}: no heading "${anchor}" in ${resolved.replace(root, '')}`);
    }
  }
  return problems;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Tracked and untracked alike: a page written and not yet committed still has to resolve.
  const files = execFileSync('git', ['ls-files', '-zco', '--exclude-standard', '*.md', '**/*.md'], {
    cwd: root,
    encoding: 'utf8',
  })
    .split('\0')
    .filter((f) => f && !SKIP.test(f));
  let failed = 0;
  for (const file of files) {
    for (const problem of checkFile(join(root, file))) {
      failed++;
      console.error(`${file}: ${problem}`);
    }
  }
  if (failed) {
    console.error(`${failed} broken link${failed === 1 ? '' : 's'}`);
    process.exit(1);
  }
  console.log(`${files.length} Markdown files, every relative link resolves`);
}
