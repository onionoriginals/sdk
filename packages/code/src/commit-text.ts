/**
 * The human-readable part of a raw git commit object (plan 049, K12), for
 * display only: the `author` header and the message. Nothing here is checked
 * or trusted beyond what `commitBinding` verified; bytes that are not UTF-8
 * are shown with replacement characters.
 */
const lenient = new TextDecoder("utf-8");

export function decodeCommitText(raw: Uint8Array): { author: string | null; message: string } {
  const text = lenient.decode(raw);
  const split = text.indexOf("\n\n");
  const header = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? "" : text.slice(split + 2).replace(/\n+$/, "");
  // Continuation lines (a signature) start with a space; only top-level headers are read.
  const author = header.split("\n").find((l) => l.startsWith("author "));
  return { author: author ? author.slice("author ".length).replace(/ \d+ [+-]\d{4}$/, "") : null, message };
}
