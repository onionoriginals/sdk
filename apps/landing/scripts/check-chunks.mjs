// Static guard for the production bundle: fail if the built chunks import each
// other in a cycle. A static import cycle between chunks makes evaluation
// order depend on which chunk the entry reaches first; when a class extends a
// base from the other chunk, the page dies with "Class extends value
// undefined" (the blank originals.build incident). Dynamic import() edges do
// not count: they run after both sides have evaluated.
//
// Usage: node scripts/check-chunks.mjs [distDir]   (default ./dist)
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const assets = join(resolve(process.argv[2] ?? 'dist'), 'assets');
const files = readdirSync(assets).filter((f) => f.endsWith('.js'));
// Minified Rolldown output: `import{a as b}from"./x.js"`, `import"./x.js"`,
// `export{...}from"./x.js"`. import("./x.js") is dynamic and excluded.
const STATIC = /(?:^|[;}\s])(?:import|export)\s*(?:[\w$*{][^"'`;]*?from\s*)?["']\.\/([^"']+\.js)["']/g;
const graph = new Map(
  files.map((f) => [f, [...new Set([...readFileSync(join(assets, f), 'utf8').matchAll(STATIC)].map((m) => m[1]))]])
);

const cycles = [];
const state = new Map(); // undefined = unvisited, 1 = on stack, 2 = done
const stack = [];
function visit(f) {
  state.set(f, 1);
  stack.push(f);
  for (const dep of graph.get(f) ?? []) {
    if (state.get(dep) === 1) cycles.push([...stack.slice(stack.indexOf(dep)), dep].join(' -> '));
    else if (!state.has(dep)) visit(dep);
  }
  stack.pop();
  state.set(f, 2);
}
for (const f of files) if (!state.has(f)) visit(f);

if (cycles.length) {
  console.error(`[check-chunks] FAILED: static import cycle between built chunks:\n  ${cycles.join('\n  ')}`);
  process.exit(1);
}
console.log(`[check-chunks] ${files.length} chunks, no static import cycle`);
