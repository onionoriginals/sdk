/**
 * Build the static viewer (plan 049 §6 milestone 1) into `viewer/dist`:
 * `index.html`, `main.js`, `worker.js` and `style.css`. Every reference is
 * relative, so the site works under any path prefix (GitHub Pages serves it
 * under `/<repo>/…`).
 *
 *   bun viewer/build.ts [--out <dir>]
 */
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { VIEW_CSS } from "../src/view.js";

const args = process.argv.slice(2);
const at = args.indexOf("--out");
const out = resolve(at >= 0 ? args[at + 1] : join(import.meta.dir, "dist"));

/** The viewer page's own additions to the view's stylesheet. */
const SHELL_CSS = `
.statusbar{background:var(--subtle);border-bottom:1px solid var(--border);padding:8px 0;font-size:12px}.statusbar .bar{margin:0}
.statusbar:empty{display:none}
#app>header.top{display:none}
.input{min-width:360px;padding:5px 8px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--fg)}
.code tr.target{background:var(--hunk)}
button.btn[disabled]{opacity:.5;cursor:default}
`;

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
const result = await Bun.build({
  entrypoints: [join(import.meta.dir, "src/main.ts"), join(import.meta.dir, "src/worker.ts")],
  outdir: out,
  target: "browser",
  format: "esm",
  minify: true,
  naming: "[name].[ext]",
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
await writeFile(join(out, "style.css"), `${VIEW_CSS}\n${SHELL_CSS}`);
await copyFile(join(import.meta.dir, "index.html"), join(out, "index.html"));
// GitHub Pages: serve files as they are (no Jekyll).
await writeFile(join(out, ".nojekyll"), "");
for (const o of result.outputs) console.log(`${o.path.slice(out.length + 1)}: ${o.size} bytes`);
console.log(`viewer built in ${out}`);
