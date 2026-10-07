/**
 * What `uptide pack test --json` wrote, in the words `uptide pack test` prints: CI keeps the
 * JSON as an artifact and shows this in the log and the job summary.
 *
 *   tsx scripts/pack-test-report.ts pack-test.json
 */
import { readFileSync } from 'node:fs';
import type { PackTestReport } from '@uptide/core';
import { formatPackTest } from '../packages/cli/src/pack.ts';

const file = process.argv[2] ?? 'pack-test.json';
const result = JSON.parse(readFileSync(file, 'utf8')) as {
  passed: boolean;
  packs: PackTestReport[];
};
const out = result.packs.map((report) => formatPackTest(report)).join('\n');
console.log(`\`\`\`\n${out}\n\`\`\``);
console.log(result.passed ? 'Every pack passed.' : 'At least one pack failed.');
