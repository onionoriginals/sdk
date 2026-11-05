/**
 * Keeps docs/CUSTODY_WALKTHROUGH.md honest (issue #1024): runs
 * examples/custody-walkthrough.ts and checks that each step's output is the
 * block the doc pastes, and that each step's outcome is what the doc says.
 *
 * After an intended change, regenerate the pasted blocks with
 *   UPDATE_CUSTODY_DOC=1 bun test tests/custody-walkthrough.test.ts
 * and review the diff of the doc.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const hostDir = join(import.meta.dir, '..');
const docPath = join(hostDir, '../../docs/CUSTODY_WALKTHROUGH.md');
// A pasted block: its marker, then a text fence. The fence may be empty, so the closing newline is optional.
const BLOCK = /(<!-- custody-walkthrough output: step (\d) -->\n```text\n)([\s\S]*?)(\n?```)$/gm;

const run = spawnSync(process.execPath, ['examples/custody-walkthrough.ts'], { cwd: hostDir, encoding: 'utf8', timeout: 120_000 });

/** The script's output for each step, keyed by step number, without the heading. */
function steps(output: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of output.split(/^## /m).slice(1)) {
    const n = part.slice(0, part.indexOf('.'));
    out.set(n, part.slice(part.indexOf('\n') + 1).trim());
  }
  return out;
}

const live = steps(run.stdout ?? '');
const step = (n: number) => live.get(String(n)) ?? '';

if (process.env.UPDATE_CUSTODY_DOC) {
  const doc = readFileSync(docPath, 'utf8');
  writeFileSync(docPath, doc.replace(BLOCK, (_m, open: string, n: string) => `${open}${live.get(n) ?? ''}\n\`\`\``));
}

describe('custody walkthrough (docs/CUSTODY_WALKTHROUGH.md, issue #1024)', () => {
  test('the script runs to completion', () => {
    expect(run.stderr ?? '', 'stderr').toBe('');
    expect(run.status).toBe(0);
    expect([...live.keys()]).toEqual(['1', '2', '3', '4', '5']);
  });

  test("the doc pastes each step's current output", () => {
    const pasted = new Map([...readFileSync(docPath, 'utf8').matchAll(BLOCK)].map((m) => [m[2], m[3].trim()]));
    expect([...pasted.keys()]).toEqual(['1', '2', '3', '4', '5']);
    for (const [n, text] of pasted) expect(text, `step ${n} in the doc`).toBe(live.get(n) ?? '(step missing from the run)');
  });

  test('step 1: the identity key is the update key only; each device has an assertionMethod key (P5.3, P5.11)', () => {
    expect(step(1)).toContain('"<identity key> (#key-0)"');
    expect(step(1)).toMatch(/"<author v2>": \{\s+"authentication": \[\s+"#key-0"\s+\],\s+"assertionMethod": \[\s+"#device-1",\s+"#device-2"\s+\]/);
  });

  test('step 2, C12-51 and C12-54: device 2 signs under the author version that added its key, with no asset-log rotation; the identity key cannot sign', () => {
    expect(step(2)).toContain('<entry 1>  author  <author>#device-1 @ <author v1>');
    expect(step(2)).toContain('<entry 2>  author  <author>#device-2 @ <author v2>');
    expect(step(2)).toContain('the verification method is not listed under assertionMethod');
    expect(step(2)).toMatch(/"authorBinding": "valid"/);
  });

  test('step 3, C12-113, C12-117 and C12-119: the agent edits under its grant, is refused once it is removed, and its entry stays valid', () => {
    expect(step(3)).toContain("agent's editor entry: accepted");
    expect(step(3)).toContain('<entry 4>  editor  <agent>#agent @ <agent v1>');
    expect(step(3)).toMatch(/"category": "unauthorized-key",\s+"code": "EDITOR_NOT_GRANTED"/);
    expect(step(3)).toMatch(/"authorBinding": "valid"[\s\S]*"historicallyAuthorizedOnly": \[\][\s\S]*"validAsOf": "<entry 5>"/);
  });

  test('step 4, C12-41 and C12-126: the seal is historically authorized only; the host refuses device 2; device 1 reconciles', () => {
    expect(step(4)).toMatch(/"versionId": "<entry 2>",\s+"did": "<author>",\s+"role": "author",\s+"reason": "key-not-in-latest-signer-document"/);
    expect(step(4)).toMatch(/"http": 422,\s+"body": \{\s+"error": "entry_historically_authorized_only",\s+"reason": "key-not-in-latest-signer-document"/);
    expect(step(4)).toMatch(/device 1 reconciles: \{\s+"status": "accepted"/);
    expect(step(4)).toContain('<entry 6>  author  <author>#device-1 @ <author v3>');
    // The finding the doc reports: the refused candidate is neither kept as refused (P6.8) nor cleared from pending.
    expect(step(4)).toMatch(/"refused": \[\],\s+"pending": "<device 2's offline entry>"/);
  });

  test('step 5, C12-01 and C12-22: a fresh process with no key and no network verifies the package, valid as of its checkpoint, never current', () => {
    expect(step(5)).toContain('secret keys in the package: none');
    expect(step(5)).toContain('verified: <original> at <entry 6>');
    expect(step(5)).toContain('<entry 2>: historically authorized only (key-not-in-latest-signer-document, P7.9)');
    expect(step(5)).toMatch(/"verified": true,[\s\S]*"current": false/);
    expect(step(5).match(/^exit 0$/gm)?.length).toBe(2);
  });
});
