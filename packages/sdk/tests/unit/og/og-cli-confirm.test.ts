/**
 * The anchoring command's confirmations (OG-ANCHOR.md: nothing is broadcast without an explicit
 * confirmation; on mainnet every confirmation is typed at the prompt). Found in the 22 November
 * regtest rehearsal: an answer piped in before a long wait was lost when standard input ended.
 */
import { describe, expect, test } from 'bun:test';
import { PassThrough } from 'node:stream';
import { confirmations } from '../../../src/og/cli.js';

function streams(tty: boolean) {
  const input = new PassThrough() as PassThrough & { isTTY?: boolean };
  input.isTTY = tty;
  const output = new PassThrough();
  let text = '';
  output.on('data', (d) => { text += String(d); });
  return { input, output, text: () => text };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

describe('confirmations', () => {
  test('a line that arrived during an earlier wait answers the next question, even after input ended', async () => {
    const s = streams(false);
    const a = confirmations(s.input, s.output, { mainnet: false });
    s.input.end('yes\n');
    await tick();
    expect(await a.confirm('Broadcast?')).toBe(true);
    // Input has ended with nothing left: the next question is a no, not an error.
    expect(await a.confirm('Again?')).toBe(false);
    expect(s.text()).toContain('no answer: input ended');
    a.close();
  });

  test('anything but "yes" is a no; an answer typed after the question is read', async () => {
    const s = streams(false);
    const a = confirmations(s.input, s.output, { mainnet: false });
    const first = a.confirm('Broadcast?');
    s.input.write('y\n');
    expect(await first).toBe(false);
    const second = a.confirm('Broadcast?');
    s.input.write('  yes \n');
    expect(await second).toBe(true);
    a.close();
  });

  test('mainnet refuses an answer that is not typed at a terminal', async () => {
    const s = streams(false);
    const a = confirmations(s.input, s.output, { mainnet: true });
    s.input.write('yes\n');
    await tick();
    expect(await a.confirm('Broadcast on mainnet?')).toBe(false);
    expect(s.text()).toContain('has to be typed at a terminal');
    a.close();
  });

  test('mainnet ignores lines typed ahead of the question', async () => {
    const s = streams(true);
    const a = confirmations(s.input, s.output, { mainnet: true });
    s.input.write('yes\n');
    await tick();
    const q = a.confirm('Broadcast on mainnet?');
    await tick();
    s.input.write('no\n');
    expect(await q).toBe(false);
    const r = a.confirm('Broadcast on mainnet?');
    await tick();
    s.input.write('yes\n');
    expect(await r).toBe(true);
    a.close();
  });
});
