#!/usr/bin/env node
/** Local CEL 3 command line entry. It has no network publication or legacy processor. */
import { readFile, writeFile, stat, realpath } from "node:fs/promises";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { OriginalsSDK } from "./OriginalsSDK.js";
import { ASSET_LIMITS } from "./envelope.js";
import {
  createLocalSigner,
  parseDocument,
  verifyHistory,
  CelError,
  CEL_LIMITS,
  type Algorithm,
} from "@originals/cel/v3";

const HELP = `originals-cel — local CEL 3 assets and authenticated history

create --file PATH --media-type TYPE --algorithm Ed25519|P-256|P-384 --key PATH
       [--name NAME] [--output PATH]
  Read a raw binary private key (32 bytes, or 48 for P-384). Emit a complete
  version-3 asset envelope with base64 media. Existing output files are refused.

verify --asset PATH
  Verify a complete local asset envelope, including all historical media bytes.
verify --log PATH [--format json|cbor]
  Authenticate CEL controller history only; this does not verify resource bytes,
  WebVH publication, Bitcoin acceptance, current ownership, or global uniqueness.
inspect --asset PATH | --log PATH [--format json|cbor]
  Inspect authenticated state; incomplete envelopes are explicitly qualified.

--help  Show help.  --version  Show the installed package version.
Network publication and resolution are not available in this CLI yet.
`;

function invalid(message: string): never {
  throw new CelError("invalid", "CLI_ARGUMENT", message);
}
function flags(args: string[], allowed: string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i],
      value = args[i + 1];
    if (
      !key?.startsWith("--") ||
      !allowed.includes(key.slice(2)) ||
      value === undefined ||
      value.startsWith("--") ||
      result.has(key.slice(2))
    )
      invalid(`Invalid, duplicate, or missing option: ${key}`);
    result.set(key.slice(2), value);
  }
  return result;
}
function required(options: Map<string, string>, key: string): string {
  const value = options.get(key);
  if (!value) invalid(`--${key} is required`);
  return value;
}
async function boundedFile(file: string, limit: number): Promise<Uint8Array> {
  const info = await stat(file);
  if (!info.isFile() || info.size > limit)
    throw new CelError(
      "limit",
      "CLI_FILE_LIMIT",
      "Input file exceeds the supported size",
    );
  const bytes = await readFile(file);
  if (bytes.length > limit)
    throw new CelError(
      "limit",
      "CLI_FILE_LIMIT",
      "Input file exceeds the supported size",
    );
  return new Uint8Array(bytes);
}
function json(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

/** Execute only local file and verification operations; callers own process exit handling. */
export async function main(
  args: string[] = process.argv.slice(2),
): Promise<void> {
  if (!args.length || args.includes("--help") || args.includes("-h")) {
    console.log(HELP);
    return;
  }
  if (args.length === 1 && (args[0] === "--version" || args[0] === "-v")) {
    const pkg = JSON.parse(
      await readFile(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    console.log(pkg.version);
    return;
  }
  const [command, ...rest] = args;
  if (command === "create") {
    const options = flags(rest, [
      "file",
      "media-type",
      "algorithm",
      "key",
      "name",
      "output",
    ]);
    const algorithm = required(options, "algorithm");
    if (!["Ed25519", "P-256", "P-384"].includes(algorithm))
      invalid("Unsupported signing algorithm");
    const file = required(options, "file");
    const mediaType = required(options, "media-type");
    const content = await boundedFile(file, ASSET_LIMITS.bytes);
    const secret = await boundedFile(
      required(options, "key"),
      algorithm === "P-384" ? 48 : 32,
    );
    const signer = createLocalSigner(algorithm as Algorithm, secret);
    const asset = await OriginalsSDK.create({ signer }).lifecycle.createAsset(
      [{ id: basename(file), mediaType, content }],
      options.has("name") ? { name: options.get("name") } : {},
    );
    const output = JSON.stringify(asset.serialize()) + "\n";
    const destination = options.get("output");
    if (destination)
      await writeFile(destination, output, { flag: "wx", mode: 0o600 });
    else process.stdout.write(output);
    return;
  }
  if (command === "verify" || command === "inspect") {
    const options = flags(rest, ["asset", "log", "format"]);
    if (Number(options.has("asset")) + Number(options.has("log")) !== 1)
      invalid("Choose exactly one of --asset or --log");
    if (options.has("asset")) {
      if (options.has("format"))
        invalid("--format applies only to --log; asset envelopes use JSON");
      const source = json(
        await boundedFile(
          required(options, "asset"),
          ASSET_LIMITS.envelopeBytes,
        ),
      );
      const { asset, verification } =
        await OriginalsSDK.create().lifecycle.loadAsset(source, {
          allowPartial: command === "inspect",
        });
      console.log(
        JSON.stringify({
          ...verification,
          ...(command === "inspect" ? { state: asset.state } : {}),
        }),
      );
    } else {
      const format = options.get("format") ?? "json";
      if (format !== "json" && format !== "cbor")
        invalid("--format must be json or cbor");
      const source = await boundedFile(
        required(options, "log"),
        CEL_LIMITS.bytes,
      );
      const history = verifyHistory(parseDocument(source, format));
      console.log(
        JSON.stringify({
          history,
          verified: false,
          scope: "controller-history",
          resources: "unchecked",
        }),
      );
    }
    return;
  }
  throw new CelError(
    "unsupported",
    "CLI_COMMAND_UNSUPPORTED",
    `Command ${command} is unavailable; use --help for supported local operations`,
  );
}

const launchedPath = process.argv[1]
  ? await realpath(process.argv[1]).catch(() => undefined)
  : undefined;
if (
  launchedPath &&
  launchedPath === (await realpath(fileURLToPath(import.meta.url)))
) {
  main().catch((error: unknown) => {
    const detail =
      error instanceof CelError
        ? { status: error.status, code: error.code, message: error.message }
        : {
            status: "invalid",
            code: "CLI_FAILED",
            message: error instanceof Error ? error.message : "Command failed",
          };
    console.error(JSON.stringify(detail));
    process.exitCode = 1;
  });
}
