/**
 * P14.16: when a writer must refuse a text block because "the version's
 * syntax would make the appended lines content rather than a comment".
 *
 * PROVISIONAL throughout. The spec gives examples ("among others": a YAML
 * document whose last node is a block scalar; Markdown or HTML ending inside
 * an unclosed code fence, `<pre>`, `<script>` or comment; a version ending
 * inside an unterminated string, heredoc or block comment of its language)
 * but no closed list, so this is a best-effort lexer per comment family, not
 * a parser of each language. It errs towards refusing: a refusal costs the
 * user a separate log file, a wrong carrier costs them visible content.
 *
 * Everything here is pure and browser-safe.
 */

/** Why a text block cannot be added, or undefined when it can. */
export type TextBlockRefusal =
  | "yaml-block-scalar"
  | "unclosed-fence"
  | "unclosed-element"
  | "unclosed-comment"
  | "unclosed-tag"
  | "unterminated-string"
  | "unterminated-heredoc"
  | "line-continuation";

const lower = (s: string) => s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));

/**
 * Elements whose content is not parsed for comments in HTML (raw text and
 * escapable raw text), plus `<pre>`, which P14.16 names. PROVISIONAL: the
 * spec names `<pre>` and `<script>`; `<pre>` content is parsed normally in
 * HTML, while `<style>`, `<textarea>`, `<title>` and the rest really do turn a
 * following `<!--` into text.
 */
const RAW_ELEMENTS = ["script", "style", "textarea", "title", "xmp", "iframe", "noembed", "noframes", "noscript", "pre"];

/**
 * Markup (`<!--` comments): HTML, XHTML, SVG, XML, and the HTML inside
 * Markdown. Refuses when the text ends inside a comment, CDATA section,
 * processing instruction, tag, or one of RAW_ELEMENTS; `<plaintext>` never ends.
 */
function markupRefusal(text: string): TextBlockRefusal | undefined {
  const t = lower(text);
  let i = 0;
  while (i < t.length) {
    const lt = t.indexOf("<", i);
    if (lt < 0) return undefined;
    if (t.startsWith("<!--", lt)) {
      const end = t.indexOf("-->", lt + 4);
      if (end < 0) return "unclosed-comment";
      i = end + 3;
      continue;
    }
    if (t.startsWith("<![cdata[", lt)) {
      const end = t.indexOf("]]>", lt + 9);
      if (end < 0) return "unclosed-element";
      i = end + 3;
      continue;
    }
    if (t.startsWith("<?", lt)) {
      const end = t.indexOf("?>", lt + 2);
      if (end < 0) return "unclosed-tag";
      i = end + 2;
      continue;
    }
    const name = /^<([a-z][a-z0-9-]*)/.exec(t.slice(lt, lt + 40));
    const closing = /^<\/[a-z]/.test(t.slice(lt, lt + 3)) || t.startsWith("<!", lt);
    if (!name && !closing) {
      i = lt + 1; // a bare `<` is text
      continue;
    }
    // Skip to the end of the tag, honouring quoted attribute values.
    let j = lt + 1;
    let quote: string | null = null;
    for (; j < t.length; j++) {
      const c = t[j];
      if (quote) {
        if (c === quote) quote = null;
      } else if (c === '"' || c === "'") quote = c;
      else if (c === ">") break;
    }
    if (j >= t.length) return "unclosed-tag";
    i = j + 1;
    if (name) {
      const element = name[1];
      if (element === "plaintext") return "unclosed-element";
      if (RAW_ELEMENTS.includes(element) && t[j - 1] !== "/") {
        const end = t.indexOf(`</${element}`, i);
        if (end < 0) return "unclosed-element";
        i = end;
      }
    }
  }
  return undefined;
}

/** Markdown: an unclosed ``` or ~~~ fence, then the HTML rules outside fences. */
function markdownRefusal(text: string): TextBlockRefusal | undefined {
  const lines = text.split("\n");
  let fence: { char: string; length: number } | null = null;
  const outside: string[] = [];
  for (const raw of lines) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (close && close[1][0] === fence.char && close[1].length >= fence.length) fence = null;
      continue;
    }
    if (open && !(open[1][0] === "`" && open[2].includes("`"))) {
      fence = { char: open[1][0], length: open[1].length };
      continue;
    }
    outside.push(line);
  }
  if (fence) return "unclosed-fence";
  return markupRefusal(outside.join("\n"));
}

/**
 * YAML: the last node is a block scalar (`|` or `>`), whose content runs on
 * while lines are blank or more indented than its key, so an appended `#`
 * line can be part of it; also a quoted scalar still open at the end.
 */
function yamlRefusal(text: string): TextBlockRefusal | undefined {
  let scalarIndent: number | null = null; // the parent's indent; -1 for a top-level `--- |`
  let quote: string | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (scalarIndent !== null) {
      const indent = line.length - line.trimStart().length;
      if (line.trim() === "" || indent > scalarIndent) continue;
      scalarIndent = null;
    }
    // Quoted scalars may span lines; track them, ignoring comments outside quotes.
    for (let k = 0; k < line.length; k++) {
      const c = line[k];
      if (quote === '"') {
        if (c === "\\") k++;
        else if (c === '"') quote = null;
      } else if (quote === "'") {
        if (c === "'" && line[k + 1] === "'") k++;
        else if (c === "'") quote = null;
      } else if (c === "#" && (k === 0 || line[k - 1] === " " || line[k - 1] === "\t")) {
        break;
      } else if ((c === '"' || c === "'") && (k === 0 || /[\s:\-[{,]/.test(line[k - 1]))) {
        quote = c;
      }
    }
    if (quote) continue;
    const block = /^(\s*)(?:(?:-\s+)*(?:[^#\s][^#]*?:\s+)?|---\s+)[|>][-+0-9]*\s*(#.*)?$/.exec(line);
    if (block) {
      scalarIndent = line.startsWith("---") ? -1 : block[1].length;
    }
  }
  if (quote) return "unterminated-string";
  return scalarIndent !== null ? "yaml-block-scalar" : undefined;
}

interface Lexer {
  /** Line comment introducers. */
  line?: string[];
  /** Block comment delimiters, and whether they nest. */
  block?: { open: string; close: string; nest?: boolean };
  /** Quotes that end at an unescaped newline. */
  singleLine?: string[];
  /** Delimiters of strings that may span lines, with whether `\` escapes inside them. */
  multiLine?: Array<{ open: string; close: string; escapes: boolean }>;
  /** Raw strings with a delimiter: `R"x(`…`)x"` (C++), `r#"`…`"#` (Rust), `#"`…`"#` (Swift). */
  raw?: "cpp" | "rust" | "swift";
  /** `$tag$`…`$tag$` (SQL). */
  dollar?: boolean;
  /** Shell heredocs. */
  heredoc?: boolean;
  /** A line comment starts only at the start of a word (shell `#`). */
  wordComment?: boolean;
  /** A backslash at the very end of the version, outside strings, joins the next line (Python, shell). */
  continuation?: boolean;
}

const C_LIKE: Lexer = { line: ["//"], block: { open: "/*", close: "*/" }, singleLine: ['"', "'"] };

/** PROVISIONAL: the lexer each text media type is checked with. */
const LEXERS: Record<string, Lexer> = {
  "text/css": { block: { open: "/*", close: "*/" }, singleLine: ['"', "'"] },
  // Template literals span lines; regular expression literals are not recognised (PROVISIONAL).
  "text/javascript": { ...C_LIKE, multiLine: [{ open: "`", close: "`", escapes: true }] },
  "application/typescript": { ...C_LIKE, multiLine: [{ open: "`", close: "`", escapes: true }] },
  "text/x-c": C_LIKE,
  "text/x-c++": { ...C_LIKE, raw: "cpp" },
  "text/x-java-source": { ...C_LIKE, multiLine: [{ open: '"""', close: '"""', escapes: true }] },
  "text/x-go": { line: ["//"], block: { open: "/*", close: "*/" }, singleLine: ['"', "'"], multiLine: [{ open: "`", close: "`", escapes: false }] },
  // Rust strings span lines; `'` is a lifetime as often as a char, so it is not treated as a quote.
  "text/x-rust": { line: ["//"], block: { open: "/*", close: "*/", nest: true }, multiLine: [{ open: '"', close: '"', escapes: true }], raw: "rust" },
  "text/x-swift": { line: ["//"], block: { open: "/*", close: "*/", nest: true }, singleLine: ['"'], multiLine: [{ open: '"""', close: '"""', escapes: true }], raw: "swift" },
  "text/x-kotlin": { line: ["//"], block: { open: "/*", close: "*/", nest: true }, singleLine: ['"', "'"], multiLine: [{ open: '"""', close: '"""', escapes: false }] },
  "text/x-python": {
    line: ["#"],
    singleLine: ['"', "'"],
    multiLine: [{ open: '"""', close: '"""', escapes: true }, { open: "'''", close: "'''", escapes: true }],
    continuation: true,
  },
  "text/x-shellscript": {
    line: ["#"],
    wordComment: true,
    multiLine: [{ open: "'", close: "'", escapes: false }, { open: '"', close: '"', escapes: true }, { open: "`", close: "`", escapes: true }],
    heredoc: true,
    continuation: true,
  },
  "application/toml": { line: ["#"], singleLine: ['"', "'"], multiLine: [{ open: '"""', close: '"""', escapes: true }, { open: "'''", close: "'''", escapes: false }] },
  "application/sql": {
    line: ["--"],
    block: { open: "/*", close: "*/" },
    multiLine: [{ open: "'", close: "'", escapes: false }, { open: '"', close: '"', escapes: false }],
    dollar: true,
  },
};

/** Run `lexer` over `text`; the refusal when the text ends inside a string, block comment or heredoc. */
function lexRefusal(text: string, lexer: Lexer): TextBlockRefusal | undefined {
  let i = 0;
  const n = text.length;
  const heredocs: Array<{ tag: string; strip: boolean }> = [];
  // Multi-line delimiters are tried longest first, so `"""` wins over `"`.
  const multi = [...(lexer.multiLine ?? [])].sort((a, b) => b.open.length - a.open.length);
  while (i < n) {
    const c = text[i];
    if (c === "\n") {
      i++;
      // Pending heredocs start after the line that opened them.
      while (heredocs.length > 0) {
        const { tag, strip } = heredocs[0];
        let found = false;
        while (i < n) {
          const end = text.indexOf("\n", i);
          const raw = text.slice(i, end < 0 ? n : end).replace(/\r$/, "");
          i = end < 0 ? n : end + 1;
          if ((strip ? raw.replace(/^\t+/, "") : raw) === tag) {
            found = true;
            break;
          }
        }
        if (!found) return "unterminated-heredoc";
        heredocs.shift();
      }
      continue;
    }
    if (lexer.block && text.startsWith(lexer.block.open, i)) {
      let depth = 1;
      i += lexer.block.open.length;
      while (i < n && depth > 0) {
        if (text.startsWith(lexer.block.close, i)) {
          depth--;
          i += lexer.block.close.length;
        } else if (lexer.block.nest && text.startsWith(lexer.block.open, i)) {
          depth++;
          i += lexer.block.open.length;
        } else i++;
      }
      if (depth > 0) return "unclosed-comment";
      continue;
    }
    const lineComment = lexer.line?.find((p) => text.startsWith(p, i));
    if (lineComment && (!lexer.wordComment || i === 0 || /\s/.test(text[i - 1]))) {
      const end = text.indexOf("\n", i);
      i = end < 0 ? n : end;
      continue;
    }
    if (lexer.raw === "cpp" && /^R"[^()\\\s]{0,16}\(/.test(text.slice(i, i + 20))) {
      const delim = /^R"([^()\\\s]{0,16})\(/.exec(text.slice(i, i + 20))![1];
      const end = text.indexOf(`)${delim}"`, i);
      if (end < 0) return "unterminated-string";
      i = end + delim.length + 2;
      continue;
    }
    if ((lexer.raw === "rust" && /^r#*"/.test(text.slice(i, i + 260)) && (i === 0 || !/[A-Za-z0-9_]/.test(text[i - 1]))) || (lexer.raw === "swift" && /^#+"/.test(text.slice(i, i + 260)))) {
      const hashes = /^r?(#*)"/.exec(text.slice(i, i + 260))![1];
      const start = text.indexOf('"', i) + 1;
      const end = text.indexOf(`"${hashes}`, start);
      if (end < 0) return "unterminated-string";
      i = end + 1 + hashes.length;
      continue;
    }
    if (lexer.dollar && c === "$") {
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.slice(i, i + 64));
      if (tag) {
        const end = text.indexOf(tag[0], i + tag[0].length);
        if (end < 0) return "unterminated-string";
        i = end + tag[0].length;
        continue;
      }
    }
    if (lexer.heredoc && text.startsWith("<<", i) && !text.startsWith("<<<", i)) {
      const m = /^<<(-?)[ \t]*(?:'([^'\n]+)'|"([^"\n]+)"|\\?([A-Za-z_][A-Za-z0-9_]*))/.exec(text.slice(i, i + 300));
      if (m) {
        heredocs.push({ tag: m[2] ?? m[3] ?? m[4], strip: m[1] === "-" });
        i += m[0].length;
        continue;
      }
    }
    const ml = multi.find((d) => text.startsWith(d.open, i));
    if (ml) {
      i += ml.open.length;
      let closed = false;
      while (i < n) {
        if (ml.escapes && text[i] === "\\") {
          i += 2;
          continue;
        }
        if (text.startsWith(ml.close, i)) {
          i += ml.close.length;
          closed = true;
          break;
        }
        i++;
      }
      if (!closed) return "unterminated-string";
      continue;
    }
    if (lexer.singleLine?.includes(c)) {
      i++;
      let closed = false;
      while (i < n) {
        if (text[i] === "\\") {
          i += 2; // an escaped newline continues the string
          continue;
        }
        if (text[i] === c) {
          i++;
          closed = true;
          break;
        }
        if (text[i] === "\n") break; // the string ends unterminated at the line end; the language rejects it, not a carrier issue
        i++;
      }
      if (!closed && i >= n) return "unterminated-string";
      continue;
    }
    i++;
  }
  if (heredocs.length > 0) return "unterminated-heredoc";
  if (lexer.continuation && /\\\r?$/.test(text)) return "line-continuation";
  return undefined;
}

/**
 * Why `text` (the version, decoded, without its BOM) cannot take a text block
 * under `mediaType` (lower case), or undefined. PROVISIONAL (P14.16).
 */
export function textBlockRefusal(text: string, mediaType: string): TextBlockRefusal | undefined {
  switch (mediaType) {
    case "text/plain":
      return undefined;
    case "text/markdown":
      return markdownRefusal(text);
    case "text/html":
    case "application/xhtml+xml":
    case "image/svg+xml":
    case "application/xml":
    case "text/xml":
      return markupRefusal(text);
    case "application/yaml":
      return yamlRefusal(text);
    default: {
      const lexer = LEXERS[mediaType];
      return lexer ? lexRefusal(text, lexer) : undefined;
    }
  }
}
