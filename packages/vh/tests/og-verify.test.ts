// did:og verification reports off Bitcoin (P7.17–P7.23, P14.25): the genesis and local vectors.
import { describe, expect, test } from 'bun:test';
import { checkAxes, defaultCheck, sameReport, verifyOriginal, type Report } from '../src/og/index.js';
import { vectorEvidence, vjson } from './helpers/og-vectors.js';

/** P14.25: the whole report, equal as JSON values, ignoring each diagnostic's reason. */
const expectSame = (got: Report, want: Report) => {
  const strip = (r: Report) => ({ ...r, diagnostics: r.diagnostics.map(({ reason: _r, ...d }) => d) });
  expect(strip(got)).toEqual(strip(want) as never);
  expect(sameReport(got, want)).toBe(true);
};

describe('vector reports (T14-075, T14-091)', () => {
  test('genesis: the whole expected report from the genesis evidence set; a complete loose set is self-contained (T7-067)', async () => {
    const report = await verifyOriginal(vectorEvidence('genesis'));
    expectSame(report, vjson('genesis/expected-report.json'));
    expect(report.axes).toMatchObject({ offline: 'self-contained' });
    expect(report.diagnostics).toEqual([]);
  });

  test('missing-resource: loose inputs without version 1: partial, needs-external, one resource-missing diagnostic (T7-068)', async () => {
    const report = await verifyOriginal(vectorEvidence('missing-resource'));
    expectSame(report, vjson('missing-resource/expected-report.json'));
    expect(report.axes).toMatchObject({ outcome: 'verified', availability: 'partial', offline: 'needs-external' });
  });

  test('local: the whole expected report from the package alone, with no network', async () => {
    const report = await verifyOriginal(vectorEvidence('local'));
    expectSame(report, vjson('local/expected-report.json'));
    expect(checkAxes(report.axes as never)).toEqual([]);
    expect(defaultCheck(report)).toBe(true);
  });

  test('T7-045: the same evidence set gives identical reports', async () => {
    const a = await verifyOriginal(vectorEvidence('local'));
    const b = await verifyOriginal(vectorEvidence('local'));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
