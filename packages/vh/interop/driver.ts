/**
 * The vh interop driver: one request per line on stdin, one response per line
 * on stdout (brianorwhatever/vh, docs/interop-protocol.md). Messages are split
 * on "\n" only, never on U+2028/U+2029 or "\r". Requests are answered strictly
 * in order.
 *
 *   bun interop/driver.ts
 */
import { handle } from "./handler.js";

const decoder = new TextDecoder();
let buffered = "";
let chain: Promise<void> = Promise.resolve();

async function answer(line: string): Promise<void> {
  if (line.length === 0) return;
  let id: unknown = null;
  try {
    const request = JSON.parse(line) as { id: unknown; op: string; input?: Record<string, unknown> };
    id = request.id;
    const response = await handle(request.op, request.input ?? {});
    process.stdout.write(`${JSON.stringify({ id, ...response })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ id, ok: false, error: String(error) })}\n`);
  }
}

process.stdin.on("data", (chunk: Uint8Array) => {
  buffered += decoder.decode(chunk, { stream: true });
  let newline: number;
  while ((newline = buffered.indexOf("\n")) >= 0) {
    const line = buffered.slice(0, newline);
    buffered = buffered.slice(newline + 1);
    chain = chain.then(() => answer(line));
  }
});

process.stdin.on("end", () => {
  const rest = buffered;
  chain = chain.then(() => answer(rest)).then(() => process.exit(0));
});
