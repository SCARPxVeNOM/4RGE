/**
 * Rendering. Separate from the checks so the verdict is a value that can be
 * asserted on, not a string that has to be scraped.
 */

import type { CheckResult, ConformanceReport } from './checks.js';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

export interface RenderOptions {
  readonly colour: boolean;
}

function mark(result: CheckResult, colour: boolean): string {
  const [symbol, tint] = result.passed
    ? ['PASS', GREEN]
    : result.severity === 'fail'
      ? ['FAIL', RED]
      : ['WARN', YELLOW];
  return colour ? `${tint}${symbol}${RESET}` : symbol;
}

export function renderReport(report: ConformanceReport, options: RenderOptions): string {
  const c = options.colour;
  const lines: string[] = [];

  lines.push('');
  lines.push(`${c ? BOLD : ''}0G Flow adapter conformance${c ? RESET : ''}  ${report.endpoint}`);
  lines.push('');

  for (const result of report.results) {
    lines.push(`  ${mark(result, c)}  ${result.title}`);
    lines.push(`        ${c ? DIM : ''}${result.detail}${c ? RESET : ''}`);
  }

  lines.push('');
  if (report.conformant) {
    const suffix =
      report.warnings === 0
        ? ''
        : ` with ${report.warnings} warning${report.warnings === 1 ? '' : 's'}`;
    lines.push(
      `  ${c ? GREEN + BOLD : ''}CONFORMANT${c ? RESET : ''}${suffix} — this agent can be composed into a flow.`,
    );
  } else {
    lines.push(
      `  ${c ? RED + BOLD : ''}NOT CONFORMANT${c ? RESET : ''} — ${report.failures} check${
        report.failures === 1 ? '' : 's'
      } failed. Composing this agent would produce runs that cannot be verified.`,
    );
  }
  lines.push('');

  return lines.join('\n');
}

/** Machine-readable form, for CI. */
export function renderJson(report: ConformanceReport): string {
  return JSON.stringify(
    {
      endpoint: report.endpoint,
      conformant: report.conformant,
      failures: report.failures,
      warnings: report.warnings,
      checks: report.results.map((r) => ({
        id: r.id,
        title: r.title,
        result: r.passed ? 'pass' : r.severity,
        detail: r.detail,
        ...(r.durationMs === undefined ? {} : { durationMs: r.durationMs }),
      })),
    },
    null,
    2,
  );
}
