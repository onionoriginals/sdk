/**
 * U2 / R6 — the anonymous inscribe step is COMPLETABLE, so "disabled and
 * greyed out" is no longer available as the signal that it is not real
 * Bitcoin. What replaces it has to survive skimming: a distinct treatment
 * that holds at any viewport and under reduced motion, and a button that can
 * never be mistaken for the signed-in money button.
 */
import { describe, test, expect } from 'bun:test';
import { inscribeStepView } from './Demo';
import { demoTier } from '../sdk/network-flag';
import { demo } from '../content';

const css = await Bun.file(new URL('./demo.css', import.meta.url)).text();

/** Drop every @media block, so what remains is what applies at EVERY viewport
 *  and under every motion preference. */
function withoutMediaQueries(source: string): string {
  let out = '';
  for (let i = 0; i < source.length; i++) {
    if (!source.startsWith('@media', i)) { out += source[i]; continue; }
    let depth = 0;
    for (; i < source.length; i++) {
      if (source[i] === '{') depth++;
      else if (source[i] === '}' && --depth === 0) break;
    }
  }
  return out;
}

const unconditional = withoutMediaQueries(css);

describe('inscribeStepView', () => {
  test('an anonymous visitor on a mainnet build is not offered step 3 as a real action', () => {
    const view = inscribeStepView(demoTier('mainnet', false).real);
    expect(view.simulated).toBe(true);
    expect(view.label).toBe(demo.simulated.action);
    expect(view.label).not.toBe(demo.steps[2].action);
    // The step's own description states the simulation too — it must not be
    // the (U5-owned) signed-in string that still says "coming soon".
    expect(view.description).toBe(demo.simulated.description);
    expect(view.description.toLowerCase()).not.toContain('coming soon');
    // Never dressed as the primary (money) button.
    expect(view.buttonClass).not.toContain('btn-primary');
    expect(view.buttonClass).toContain('demo-sim-btn');
  });

  test('a signed-in visitor on a mainnet build gets the real inscribe action', () => {
    const view = inscribeStepView(demoTier('mainnet', true).real);
    expect(view.simulated).toBe(false);
    expect(view.label).toBe(demo.steps[2].action);
    expect(view.description).toBe(demo.steps[2].description);
    expect(view.buttonClass).toContain('btn-primary');
    expect(view.buttonClass).not.toContain('demo-sim-btn');
  });

  test('the mock deploy (flag off) is the simulated tier for everyone', () => {
    expect(inscribeStepView(demoTier('off', true).real).simulated).toBe(true);
    expect(inscribeStepView(demoTier('off', false).real).simulated).toBe(true);
  });
});

describe('simulated-tier copy', () => {
  test('content.ts carries the simulated tier’s strings', () => {
    for (const key of ['badge', 'action', 'pending', 'description', 'note'] as const) {
      expect(typeof demo.simulated[key]).toBe('string');
      expect(demo.simulated[key].length).toBeGreaterThan(0);
    }
  });

  test('the simulated tier names itself and denies the Bitcoin network', () => {
    expect(demo.simulated.badge.toLowerCase()).toContain('simulat');
    expect(demo.simulated.description.toLowerCase()).toContain('mock');
    expect(demo.simulated.note.toLowerCase()).toMatch(/nothing .*reaches|no sats/);
    for (const s of [demo.simulated.description, demo.simulated.note]) {
      expect(s).not.toMatch(/broadcasts|spends your|your own btc/i);
    }
  });
});

describe('simulated-tier visual treatment', () => {
  test('the step, its badge and its button all carry a distinct treatment', () => {
    expect(unconditional).toContain(".demo-step[data-sim]");
    expect(unconditional).toContain('.demo-sim-badge');
    expect(unconditional).toContain('.demo-sim-btn');
  });

  test('the treatment holds at 375px and 1440px — it is not inside a media query', () => {
    // Every simulated-tier selector survives stripping all @media blocks, so
    // no viewport can drop the signal.
    const simRules = css.match(/^[^@{}]*\bsim\b[^{}]*\{/gm) ?? [];
    expect(simRules.length).toBeGreaterThan(2);
    for (const rule of simRules) expect(unconditional).toContain(rule.trim());
  });

  test('the treatment is static — reduced motion cannot take it away', () => {
    const blocks = unconditional.match(/[^{}]*\bsim\b[^{}]*\{[^}]*\}/g) ?? [];
    expect(blocks.length).toBeGreaterThan(2);
    for (const block of blocks) {
      expect(block).not.toContain('animation');
      expect(block).not.toContain('transform');
    }
  });

  test('the step header wraps, so the extra badge cannot overflow a 375px screen', () => {
    expect(unconditional).toMatch(/\.demo-step-title\s*\{[^}]*flex-wrap:\s*wrap/);
  });
});
