// The build about to be published must say it came from a committed, clean Uptide tree:
// `fix --pr` refuses to run from a dirty build, and a published build must never be one.
import { uptideVersionInfo } from '../packages/core/dist/index.js';

const info = uptideVersionInfo();
if (info.uptideDirty || info.uptideCommit === 'unknown') {
  console.error(`build stamp is not publishable: ${JSON.stringify(info)}`);
  process.exit(1);
}
console.log(`build stamp: ${info.uptideVersion} at ${info.uptideCommit} (clean)`);
