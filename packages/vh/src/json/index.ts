/**
 * Strict JSON and JCS (RFC 8785).
 *
 * VH-Log hashes and signs JCS output, so every value this package accepts must
 * canonicalize to exactly one byte string. The parser therefore rejects what
 * `JSON.parse` silently tolerates (Originals P5.7): duplicate keys, lone UTF-16
 * surrogates, integer literals that lose precision as doubles, `-0`, overflow
 * to infinity, and anything outside RFC 8259.
 */
import { OriginalsError } from "../errors.js";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}

export interface ParseLimits {
  /** Maximum UTF-16 length of the input text. */
  maxBytes?: number;
  /** Maximum nesting depth of arrays and objects. */
  maxDepth?: number;
}

const DEFAULT_MAX_DEPTH = 64;

function syntax(message: string, at: number): never {
  throw new OriginalsError("invalid-evidence", "JSON_SYNTAX", `${message} at offset ${at}`);
}

function hasLoneSurrogate(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

const NUMBER = /-?(?:0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/y;

class Parser {
  private at = 0;
  constructor(
    private readonly text: string,
    private readonly maxDepth: number,
  ) {}

  parseDocument(): JsonValue {
    const value = this.value(0);
    this.whitespace();
    if (this.at !== this.text.length) syntax("unexpected trailing content", this.at);
    return value;
  }

  private whitespace(): void {
    while (this.at < this.text.length) {
      const c = this.text.charCodeAt(this.at);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) this.at++;
      else break;
    }
  }

  private value(depth: number): JsonValue {
    this.whitespace();
    const c = this.text[this.at];
    if (c === "{" || c === "[") {
      if (depth >= this.maxDepth) {
        throw new OriginalsError("limit-exceeded", "JSON_TOO_DEEP", `JSON nesting exceeds ${this.maxDepth}`);
      }
      return c === "{" ? this.object(depth + 1) : this.array(depth + 1);
    }
    if (c === '"') return this.string();
    if (this.text.startsWith("true", this.at)) return this.literal("true", true);
    if (this.text.startsWith("false", this.at)) return this.literal("false", false);
    if (this.text.startsWith("null", this.at)) return this.literal("null", null);
    return this.number();
  }

  private literal<T>(word: string, value: T): T {
    this.at += word.length;
    return value;
  }

  private object(depth: number): JsonObject {
    this.at++;
    const result: JsonObject = {};
    const seen = new Set<string>();
    this.whitespace();
    if (this.text[this.at] === "}") {
      this.at++;
      return result;
    }
    for (;;) {
      this.whitespace();
      if (this.text[this.at] !== '"') syntax("expected a string key", this.at);
      const keyAt = this.at;
      const key = this.string();
      if (seen.has(key)) {
        throw new OriginalsError("invalid-evidence", "JSON_DUPLICATE_KEY", `duplicate key ${JSON.stringify(key)} at offset ${keyAt}`);
      }
      seen.add(key);
      this.whitespace();
      if (this.text[this.at] !== ":") syntax("expected ':'", this.at);
      this.at++;
      // defineProperty keeps "__proto__" an ordinary own key.
      Object.defineProperty(result, key, { value: this.value(depth), enumerable: true, writable: true, configurable: true });
      this.whitespace();
      const next = this.text[this.at++];
      if (next === "}") return result;
      if (next !== ",") syntax("expected ',' or '}'", this.at - 1);
    }
  }

  private array(depth: number): JsonValue[] {
    this.at++;
    const result: JsonValue[] = [];
    this.whitespace();
    if (this.text[this.at] === "]") {
      this.at++;
      return result;
    }
    for (;;) {
      result.push(this.value(depth));
      this.whitespace();
      const next = this.text[this.at++];
      if (next === "]") return result;
      if (next !== ",") syntax("expected ',' or ']'", this.at - 1);
    }
  }

  private string(): string {
    const start = this.at++;
    let out = "";
    for (;;) {
      if (this.at >= this.text.length) syntax("unterminated string", start);
      const c = this.text.charCodeAt(this.at);
      if (c === 0x22) {
        this.at++;
        break;
      }
      if (c < 0x20) syntax("unescaped control character in string", this.at);
      if (c !== 0x5c) {
        out += this.text[this.at++];
        continue;
      }
      const e = this.text[this.at + 1];
      this.at += 2;
      switch (e) {
        case '"': out += '"'; break;
        case "\\": out += "\\"; break;
        case "/": out += "/"; break;
        case "b": out += "\b"; break;
        case "f": out += "\f"; break;
        case "n": out += "\n"; break;
        case "r": out += "\r"; break;
        case "t": out += "\t"; break;
        case "u": {
          const hex = this.text.slice(this.at, this.at + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) syntax("invalid \\u escape", this.at - 2);
          out += String.fromCharCode(parseInt(hex, 16));
          this.at += 4;
          break;
        }
        default:
          syntax("invalid escape", this.at - 2);
      }
    }
    if (hasLoneSurrogate(out)) {
      throw new OriginalsError("invalid-evidence", "JSON_LONE_SURROGATE", `string at offset ${start} contains a lone surrogate`);
    }
    return out;
  }

  private number(): number {
    NUMBER.lastIndex = this.at;
    const match = NUMBER.exec(this.text);
    if (!match) syntax("unexpected character", this.at);
    const literal = match[0];
    this.at += literal.length;
    const value = Number(literal);
    const integerLiteral = match[1] === undefined && match[2] === undefined;
    if (!Number.isFinite(value) || Object.is(value, -0) || (integerLiteral && !Number.isSafeInteger(value))) {
      throw new OriginalsError("invalid-evidence", "JSON_UNSAFE_NUMBER", `number ${literal} cannot be represented exactly`);
    }
    return value;
  }
}

/** Parse one strict JSON value. */
export function parseJson(text: string, limits: ParseLimits = {}): JsonValue {
  if (limits.maxBytes !== undefined && text.length > limits.maxBytes) {
    throw new OriginalsError("limit-exceeded", "JSON_TOO_LARGE", `JSON text exceeds ${limits.maxBytes} bytes`);
  }
  return new Parser(text, limits.maxDepth ?? DEFAULT_MAX_DEPTH).parseDocument();
}

/** Parse JSON Lines: one strict value per line; a final newline is optional, blank lines are not. */
export function parseJsonLines(text: string, limits: ParseLimits = {}): JsonValue[] {
  if (limits.maxBytes !== undefined && text.length > limits.maxBytes) {
    throw new OriginalsError("limit-exceeded", "JSON_TOO_LARGE", `JSON Lines text exceeds ${limits.maxBytes} bytes`);
  }
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  return body.split("\n").map((line, index) => {
    if (line.length === 0) {
      throw new OriginalsError("invalid-evidence", "JSONL_BLANK_LINE", `line ${index + 1} is empty`);
    }
    return new Parser(line, limits.maxDepth ?? DEFAULT_MAX_DEPTH).parseDocument();
  });
}

function unsupported(message: string): never {
  throw new OriginalsError("invalid-evidence", "JCS_UNSUPPORTED_VALUE", message);
}

/** RFC 8785 JSON Canonicalization Scheme. */
export function canonicalize(value: JsonValue): string {
  switch (typeof value) {
    case "string":
      if (hasLoneSurrogate(value)) unsupported("string contains a lone surrogate");
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value) || Object.is(value, -0)) unsupported(`number ${String(value)} is not canonicalizable`);
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "object": {
      if (value === null) return "null";
      if (Array.isArray(value)) return `[${value.map((item) => canonicalize(item)).join(",")}]`;
      const proto = Object.getPrototypeOf(value) as unknown;
      if (proto !== Object.prototype && proto !== null) unsupported("only plain objects are JSON objects");
      const keys = Object.keys(value).sort();
      return `{${keys.map((key) => {
        const item = value[key];
        if (item === undefined) unsupported(`member ${JSON.stringify(key)} is undefined`);
        if (hasLoneSurrogate(key)) unsupported("key contains a lone surrogate");
        return `${JSON.stringify(key)}:${canonicalize(item)}`;
      }).join(",")}}`;
    }
    default:
      return unsupported(`${typeof value} is not a JSON value`);
  }
}

const encoder = new TextEncoder();

/** UTF-8 bytes of the JCS serialization. */
export function canonicalBytes(value: JsonValue): Uint8Array {
  return encoder.encode(canonicalize(value));
}

/** True when `value` is a plain JSON object (not an array or null). */
export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
