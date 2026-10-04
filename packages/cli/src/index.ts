#!/usr/bin/env node
import { run, VERSION } from './cli.js';
import { renderError } from './errors.js';
import { processIo } from './io.js';
import { createTelemetry } from './telemetry/client.js';

const io = processIo();
run(process.argv.slice(2), io, undefined, createTelemetry(io, { version: VERSION })).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(renderError(err, false));
    process.exitCode = 2;
  },
);
