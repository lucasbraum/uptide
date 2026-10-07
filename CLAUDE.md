# CLAUDE.md

Instructions for Claude Code in this repository. CONTRIBUTING.md has the rest.

## Tools

Never run bare `npx <tool>` in this repo. Install first (`pnpm install
--frozen-lockfile --ignore-scripts`), then use `pnpm exec <tool>` or the package
script. A bare npx without local deps downloads and runs whatever package has that
name on npm.
