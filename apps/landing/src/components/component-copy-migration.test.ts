/**
 * U5 / KTD9 — "all user-visible copy lives in content.ts" is the house rule
 * (apps/landing/README.md), and these six components were the ones still
 * breaking it. A rule nothing checks is a rule that decays, so this scans
 * their source for copy that never made the move.
 *
 * Scope is deliberately the six files this unit migrates. Other rendered
 * components still carry literals and are out of scope here.
 */
import { describe, test, expect } from 'bun:test';

const FILES = [
  'IdentityPanel.tsx',
  'LoginModal.tsx',
  'Nav.tsx',
  'OtpInput.tsx',
  'Developers.tsx',
  'InstallCommand.tsx',
];

/** Attribute values that are markup or styling, never copy. */
const TECHNICAL_ATTRS = [
  'className', 'class', 'key', 'id', 'htmlFor', 'href', 'rel', 'target', 'type', 'style',
  'name', 'role', 'autoComplete', 'inputMode', 'xmlns', 'viewBox', 'd', 'fill', 'stroke',
  'strokeWidth', 'strokeLinecap', 'strokeLinejoin', 'strokeDasharray', 'cx', 'cy', 'r',
  'rx', 'ry', 'x', 'y', 'width', 'height', 'points', 'transform', 'aria-hidden',
  'aria-modal', 'aria-selected', 'aria-expanded', 'aria-busy', 'aria-live',
];

/** Copy-shaped attributes: whatever they carry is read by a human. */
const COPY_ATTRS = ['aria-label', 'placeholder', 'title', 'alt'];

/**
 * String literals that are code the browser reads, not words a person does:
 * KeyboardEvent key names.
 */
const CODE_LITERALS = new Set(['Backspace', 'ArrowLeft', 'ArrowRight', 'Enter', 'Escape', 'Tab']);

async function read(file: string): Promise<string> {
  return Bun.file(new URL(`./${file}`, import.meta.url)).text();
}

function stripTechnicalAttrs(source: string): string {
  let out = source;
  for (const attr of TECHNICAL_ATTRS) {
    out = out.replace(new RegExp(`${attr}\\s*=\\s*(?:"[^"]*"|'[^']*'|\\{[^{}]*\\})`, 'g'), '');
  }
  return out;
}

function stripImports(source: string): string {
  return source.replace(/^import[\s\S]*?from\s+['"][^'"]+['"];?$/gm, '').replace(/^import\s+['"][^'"]+['"];?$/gm, '');
}

/** Every quoted literal left over, with `${…}` holes removed. */
function stringLiterals(source: string): string[] {
  const out: string[] = [];
  const re = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g;
  for (const m of source.matchAll(re)) {
    out.push((m[1] ?? m[2] ?? m[3] ?? '').replace(/\$\{[^}]*\}/g, ''));
  }
  return out;
}

/**
 * A literal reads as copy when it is a sentence or a Capitalised label. Code
 * literals in these files are lowercase single tokens ('email', 'button',
 * 'idle'), so this catches words meant for a person without flagging them.
 */
function looksLikeCopy(literal: string): boolean {
  const value = literal.trim();
  if (!/[A-Za-z]/.test(value)) return false;
  if (CODE_LITERALS.has(value)) return false;
  return /\s/.test(value) || /[A-Z]/.test(value) || value.includes('@');
}

/** Text rendered between JSX tags or beside an expression hole. */
function jsxText(source: string): string[] {
  const jsx = source.slice(source.indexOf('return ('));
  const out: string[] = [];
  for (const m of jsx.matchAll(/[>}]([^<>{}]*)[<{]/g)) {
    const text = m[1].trim();
    if (!/[A-Za-z]/.test(text)) continue;
    // Statement fragments between two braces in an inline handler are code.
    if (/[();=]/.test(text)) continue;
    out.push(text);
  }
  return out;
}

describe.each(FILES)('%s carries no user-visible string literal', (file) => {
  test('nothing rendered between tags is written in the component', async () => {
    expect(jsxText(await read(file))).toEqual([]);
  });

  test('aria-label, placeholder, title and alt read from content.ts', async () => {
    const source = await read(file);
    const offenders: string[] = [];
    for (const attr of COPY_ATTRS) {
      for (const m of source.matchAll(new RegExp(`${attr}\\s*=\\s*(?:("[^"]*"|'[^']*')|(\\{[^{}]*\\}))`, 'g'))) {
        const value = m[1] ?? m[2] ?? '';
        for (const literal of stringLiterals(value)) {
          if (/[A-Za-z]/.test(literal.trim())) offenders.push(`${attr}=${value}`);
        }
        // A bare quoted value with letters is copy by definition.
        if (m[1] && /[A-Za-z]/.test(m[1])) offenders.push(`${attr}=${m[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('no sentence or label is left as a string literal anywhere in the file', async () => {
    const source = stripTechnicalAttrs(stripImports(await read(file)));
    // Comments explain the code; they are not shipped to a visitor.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(stringLiterals(code).filter(looksLikeCopy)).toEqual([]);
  });

  test('it imports its copy from content.ts', async () => {
    expect(await read(file)).toMatch(/from '\.\.\/content'/);
  });
});
