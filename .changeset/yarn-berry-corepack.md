---
"uptide": patch
---

`fix` and `verify` install a repository that pins Yarn 2 or later in `packageManager` even
when the `yarn` on PATH is classic 1.x or absent: the pinned version runs through corepack
(`corepack yarn install ...`, download prompt off) without enabling corepack or changing
anything on your machine outside corepack's cache. Before, Yarn stopped the run with "the
current global version of Yarn is 1.22.22". When corepack is missing, the run stops before
cloning with exit code 2 and the command to run (`corepack enable`); when corepack cannot
fetch the pinned version, the message names `COREPACK_NPM_REGISTRY` for corporate mirrors.
