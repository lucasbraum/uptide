import { uptideCommand } from '@uptide/core';
import { VERSION } from './version.js';

/** `npx uptide`, or `npx uptide@next` when this build is a prerelease: commands must reach this build. */
export const INVOCATION = uptideCommand(VERSION);

/**
 * One command style in every suggestion: a command written as `uptide …` (at the start, or
 * inside backticks) is printed with the invocation that reaches this build.
 */
export const runnable = (text: string): string =>
  text.replace(/(^|`)uptide (?=[a-z-])/g, `$1${INVOCATION} `);
