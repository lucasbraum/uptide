import { readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Io } from '../io.js';
import { BUILD_HOST, BUILD_KEY, captureUrl } from './config.js';
import {
  buildEvent,
  COMMANDS,
  type Metrics,
  type PublicVersion,
  sanitizeEvent,
  type TelemetryCommand,
} from './payload.js';
import { cachedPublicVersion } from './public-packages.js';
import {
  atomicJson,
  enabled,
  identity,
  isCi,
  readSettings,
  type Settings,
  settingsPath,
} from './settings.js';
import { type Delivery, dispatch } from './transport.js';

export interface Telemetry {
  begin(command: string, flags: { ci?: boolean; json?: boolean; cwd?: string }): Promise<void>;
  record(metrics: () => Metrics): void;
  finish(code: number): void;
  control(action: string, ci?: boolean): unknown;
}
export interface Options {
  path?: string;
  key?: string;
  host?: string;
  version: string;
  publicVersion?: PublicVersion;
  dispatch?: (delivery: Delivery) => void;
}
export function createTelemetry(io: Io, options: Options): Telemetry {
  const path = options.path ?? settingsPath(io.env);
  const last = join(dirname(path), 'telemetry-last.json');
  const publicVersion = options.publicVersion ?? cachedPublicVersion(io.env);
  const key = options.key ?? BUILD_KEY;
  const url = captureUrl(io.env.UPTIDE_TELEMETRY_HOST ?? options.host ?? BUILD_HOST);
  const configured = /^phc_[A-Za-z0-9_-]+$/.test(key) && url !== undefined;
  let settings: Required<Settings> | undefined;
  let command: TelemetryCommand | undefined;
  let metrics: Metrics = {};
  let started = 0;
  const status = (ci = false) => {
    const saved = readSettings(path);
    const active = enabled(saved, io.env, isCi(io.env, ci));
    return {
      preference: saved === undefined ? 'unset' : saved.consent ? 'on' : 'off',
      enabled: active,
      transport: configured ? 'configured' : 'disabled: no capture key or invalid HTTPS host',
      sending: active && configured,
      override:
        io.env.UPTIDE_TELEMETRY === '0'
          ? 'environment: off'
          : io.env.UPTIDE_TELEMETRY === '1'
            ? 'environment: on'
            : isCi(io.env, ci)
              ? 'CI: off (set UPTIDE_TELEMETRY=1 to opt in)'
              : 'none',
    };
  };
  return {
    async begin(name, flags) {
      settings = undefined;
      command = undefined;
      metrics = {};
      try {
        const known = name === 'uptide' ? 'status' : name;
        if (!COMMANDS.includes(known as TelemetryCommand)) return;
        let saved = readSettings(path);
        const ci = isCi(io.env, flags.ci);
        if (
          saved === undefined &&
          io.env.UPTIDE_TELEMETRY === undefined &&
          !ci &&
          !flags.json &&
          io.inTty &&
          io.outTty &&
          io.errTty &&
          io.confirmTelemetry
        ) {
          saved = { consent: (await io.confirmTelemetry()) === true };
          atomicJson(path, saved);
        }
        if (!enabled(saved, io.env, ci)) return;
        settings = identity(saved ?? { consent: false });
        atomicJson(path, settings);
        command = known as TelemetryCommand;
        metrics = { repo: resolve(io.cwd, flags.cwd ?? '.') };
        started = io.now();
      } catch {
        settings = undefined;
        command = undefined;
      }
    },
    record(value) {
      if (!command) return;
      try {
        metrics = { ...metrics, ...value() };
      } catch {
        /* Optional observation never changes the run. */
      }
    },
    finish(code) {
      try {
        if (!settings || !command) return;
        // Respect an opt-out written by another CLI during a long analysis.
        if (!enabled(readSettings(path), io.env, isCi(io.env))) return;
        const event = buildEvent(
          settings,
          command,
          options.version,
          metrics,
          io.now() - started,
          code,
          publicVersion,
        );
        if (!event) return;
        atomicJson(last, event);
        if (!configured || !url) return;
        (options.dispatch ?? dispatch)({ url, key, event });
      } catch {
        /* No logging of failed payloads, and no change to the command's exit code. */
      }
    },
    control(action, ci) {
      if (action === 'status') return status(ci);
      if (action === 'show') {
        try {
          return sanitizeEvent(JSON.parse(readFileSync(last, 'utf8')), publicVersion) ?? null;
        } catch {
          return null;
        }
      }
      if (action === 'on') atomicJson(path, identity({ ...readSettings(path), consent: true }));
      else if (action === 'off') {
        atomicJson(path, { consent: false });
        rmSync(last, { force: true });
      } else throw new Error('Expected telemetry on, off, status or show.');
      return status(ci);
    },
  };
}
