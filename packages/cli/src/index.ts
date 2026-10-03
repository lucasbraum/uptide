#!/usr/bin/env node
import { run } from './cli.js';
import { renderError } from './errors.js';
import { processIo } from './io.js';

run(process.argv.slice(2), processIo()).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(renderError(err, false));
    process.exitCode = 2;
  },
);
