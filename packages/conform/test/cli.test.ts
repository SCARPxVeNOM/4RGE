import { describe, expect, it } from 'vitest';
import { parseArgs } from '../src/cli.js';

const parsed = (argv: string[]) => parseArgs(argv) as Exclude<ReturnType<typeof parseArgs>, { help: string }>;

describe('parseArgs', () => {
  it('takes the endpoint and applies defaults', () => {
    const options = parsed(['http://localhost:8710/agents/audit']);
    expect(options.endpoint).toBe('http://localhost:8710/agents/audit');
    expect(options.timeoutMs).toBe(15_000);
    expect(options.json).toBe(false);
    expect(options.input).toBeUndefined();
  });

  it('shows help with no arguments rather than failing obscurely', () => {
    expect(parseArgs([])).toHaveProperty('help');
    expect(parseArgs(['--help'])).toHaveProperty('help');
    expect(parseArgs(['-h'])).toHaveProperty('help');
  });

  it('rejects an endpoint that is not an http(s) URL', () => {
    expect(() => parseArgs(['localhost:8710'])).toThrow('http(s) URL');
    expect(() => parseArgs(['ws://host/agent'])).toThrow('http(s) URL');
  });

  it('rejects two endpoints, rather than silently conforming one', () => {
    expect(() => parseArgs(['http://a', 'http://b'])).toThrow('exactly one endpoint');
  });

  it('rejects an unknown option instead of treating it as an endpoint', () => {
    expect(() => parseArgs(['http://a', '--verbose'])).toThrow('unknown option --verbose');
  });

  it('parses --timeout and rejects nonsense', () => {
    expect(parsed(['http://a', '--timeout', '500']).timeoutMs).toBe(500);
    for (const bad of ['0', '-1', 'soon']) {
      expect(() => parseArgs(['http://a', '--timeout', bad]), bad).toThrow('positive number');
    }
  });

  it('parses --input as a JSON object', () => {
    expect(parsed(['http://a', '--input', '{"repo":"x"}']).input).toEqual({ repo: 'x' });
  });

  it('rejects an --input that is not a JSON object', () => {
    expect(() => parseArgs(['http://a', '--input', 'not json'])).toThrow('not valid JSON');
    expect(() => parseArgs(['http://a', '--input', '[1,2]'])).toThrow('must be a JSON object');
    expect(() => parseArgs(['http://a', '--input', '"text"'])).toThrow('must be a JSON object');
  });

  it('accepts --json and both spellings of the colour flags', () => {
    expect(parsed(['http://a', '--json']).json).toBe(true);
    expect(parsed(['http://a', '--no-color']).colour).toBe(false);
    expect(parsed(['http://a', '--no-colour']).colour).toBe(false);
    expect(parsed(['http://a', '--color']).colour).toBe(true);
  });
});
