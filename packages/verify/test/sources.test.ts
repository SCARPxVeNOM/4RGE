import { describe, expect, test } from 'vitest';
import { isIndexerErrorEnvelope } from '../src/sources.js';

/**
 * The 0G Storage indexer answers a missing file with HTTP 200 and an error
 * envelope in the body:
 *
 *   {"code":101,"message":"File not found","data":null}
 *
 * A client that keys off the status code alone hands that envelope to the
 * verifier as though it were a trace. The verifier then reports a *failed*
 * hash check for a file that simply is not there — an outright wrong answer,
 * and exactly the class of mistake §1.3 exists to prevent.
 */

const bytes = (s: string) => new TextEncoder().encode(s);

describe('isIndexerErrorEnvelope', () => {
  test('recognises the real not-found envelope', () => {
    expect(isIndexerErrorEnvelope(bytes('{"code":101,"message":"File not found","data":null}'))).toBe(true);
  });

  test('recognises other non-zero codes', () => {
    expect(isIndexerErrorEnvelope(bytes('{"code":7,"message":"whatever"}'))).toBe(true);
  });

  test('does not mistake a trace for an envelope', () => {
    const trace = '{"input":{"repo":"x"},"output":{"report":"y"},"stepId":"audit"}';
    expect(isIndexerErrorEnvelope(bytes(trace))).toBe(false);
  });

  test('does not mistake a trace that happens to carry a code field', () => {
    // A step output could legitimately contain {"code": 500}; only the
    // envelope's exact shape counts.
    const trace = '{"input":{},"output":{"code":500,"message":"upstream said so"}}';
    expect(isIndexerErrorEnvelope(bytes(trace))).toBe(false);
  });

  test('treats code 0 as success rather than an error', () => {
    expect(isIndexerErrorEnvelope(bytes('{"code":0,"message":"ok","data":{}}'))).toBe(false);
  });

  test('treats non-JSON bytes as a file, not an envelope', () => {
    expect(isIndexerErrorEnvelope(bytes('not json at all'))).toBe(false);
    expect(isIndexerErrorEnvelope(new Uint8Array([0x00, 0x01, 0xff]))).toBe(false);
  });
});
