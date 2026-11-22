// did:og verification reports off Bitcoin (P7.17–P7.23, P14.25): the genesis and local vectors.
import { describe, expect, test } from 'bun:test';
import { checkAxes, defaultCheck, verifyOriginal } from '../src/og/index.js';
import { vectorEvidence, vjson } from './helpers/og-vectors.js';

describe('vector reports (T14-075, T14-091)', () => {
  test('genesis: the expected report from the genesis evidence set', async () => {
    const report = await verifyOriginal(vectorEvidence('genesis'));
    expect(report).toEqual(vjson('genesis/expected-report.json'));
  });

  test('local: the expected report from the package alone, with no network', async () => {
    const report = await verifyOriginal(vectorEvidence('local'));
    expect(report).toEqual(vjson('local/expected-report.json'));
    expect(checkAxes(report.axes as never)).toEqual([]);
    expect(defaultCheck(report)).toBe(true);
  });

  test('T7-045: the same evidence set gives identical reports', async () => {
    const a = await verifyOriginal(vectorEvidence('local'));
    const b = await verifyOriginal(vectorEvidence('local'));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
