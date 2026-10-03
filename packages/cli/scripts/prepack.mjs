// The npm page shows the README and LICENSE of the package directory; ours live at the
// repository root. Copy them in for the tarball and remove them again afterwards.
import { copyFileSync, rmSync } from 'node:fs';

const files = ['README.md', 'LICENSE'];
for (const file of files) {
  const here = new URL(`../${file}`, import.meta.url);
  if (process.argv.includes('--clean')) rmSync(here, { force: true });
  else copyFileSync(new URL(`../../../${file}`, import.meta.url), here);
}
