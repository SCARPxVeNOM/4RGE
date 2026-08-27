/**
 * `npx @0gflow/conform <endpoint>` — spec §6.4.
 *
 * Exit code 1 on any failure, so a CI job that runs this actually gates on it.
 * Warnings never change the exit code: a suite people learn to ignore is worse
 * than no suite.
 */

import { runConformance } from './checks.js';
import { createHttpProbe } from './probe.js';
import { renderJson, renderReport } from './report.js';
import type { JsonValue } from '@0gflow/core';

const USAGE = `
0G Flow adapter conformance — spec §6.4

  npx @0gflow/conform <endpoint> [options]

  <endpoint>          Base URL of the agent, e.g. http://localhost:8710/agents/audit
                      The suite appends /health, /schema and /invoke.

  --json              Emit machine-readable JSON instead of a report.
  --timeout <ms>      Per-request timeout. Default 15000.
  --input <json>      Override the schema-derived golden input.
  --no-color          Disable colour.

Exit code is 0 when the agent is conformant, 1 otherwise. Warnings do not
change the exit code.
`;

interface Options {
  readonly endpoint: string;
  readonly json: boolean;
  readonly timeoutMs: number;
  readonly input: Record<string, JsonValue> | undefined;
  readonly colour: boolean;
}

export function parseArgs(argv: readonly string[]): Options | { readonly help: string } {
  const positional: string[] = [];
  let json = false;
  let timeoutMs = 15_000;
  let input: Record<string, JsonValue> | undefined;
  let colour = process.stdout.isTTY === true && process.env['NO_COLOR'] === undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--help' || arg === '-h') return { help: USAGE };
    else if (arg === '--json') json = true;
    else if (arg === '--no-color' || arg === '--no-colour') colour = false;
    else if (arg === '--color' || arg === '--colour') colour = true;
    else if (arg === '--timeout') {
      const value = Number(argv[++i]);
      if (!Number.isFinite(value) || value <= 0) throw new Error('--timeout needs a positive number of milliseconds');
      timeoutMs = value;
    } else if (arg === '--input') {
      const raw = argv[++i];
      if (raw === undefined) throw new Error('--input needs a JSON object');
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new Error('--input is not valid JSON');
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('--input must be a JSON object');
      }
      input = parsed as Record<string, JsonValue>;
    } else if (arg.startsWith('-')) {
      throw new Error(`unknown option ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  const endpoint = positional[0];
  if (endpoint === undefined) return { help: USAGE };
  if (!/^https?:\/\//.test(endpoint)) {
    throw new Error(`endpoint must be an http(s) URL; got ${endpoint}`);
  }
  if (positional.length > 1) throw new Error('expected exactly one endpoint');

  return { endpoint, json, timeoutMs, input, colour };
}

export async function main(argv: readonly string[]): Promise<number> {
  let options: Options;
  try {
    const parsed = parseArgs(argv);
    if ('help' in parsed) {
      console.log(parsed.help);
      return 0;
    }
    options = parsed;
  } catch (error) {
    console.error(`error: ${(error as Error).message}`);
    console.error(USAGE);
    return 2;
  }

  const report = await runConformance({
    endpoint: options.endpoint,
    probe: createHttpProbe(options.endpoint, options.timeoutMs),
    ...(options.input === undefined ? {} : { input: options.input }),
  });

  console.log(options.json ? renderJson(report) : renderReport(report, { colour: options.colour }));
  return report.conformant ? 0 : 1;
}

const invokedDirectly =
  process.argv[1] !== undefined && /conform(\/|\\)(dist(\/|\\))?(src(\/|\\))?cli\.(js|ts)$/.test(process.argv[1]);

if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(`error: ${(error as Error).message}`);
      process.exitCode = 2;
    });
}
