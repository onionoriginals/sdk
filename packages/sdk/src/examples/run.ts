/**
 * Run the current checkout's self-contained local example after `bun run build`.
 * From packages/sdk: bun run src/examples/run.ts [basic]
 */
import { basicExample } from "./basic-usage.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    console.log("Usage: bun run src/examples/run.ts [basic]");
    console.log(
      "Create, edit, serialize and verify a local Original with a disposable key.",
    );
    console.log(
      "No network publication, Bitcoin transaction, or file write is performed.",
    );
    return;
  }
  if (args.length > 1 || (args.length === 1 && args[0] !== "basic")) {
    throw new Error(
      `Unsupported example arguments: ${args.join(" ")}. Use 'basic' or '--help'. ` +
        "The other example files describe previous SDK APIs; see src/examples/README.md.",
    );
  }

  const { asset, verification } = await basicExample();
  console.log("Recovered local Original:", asset.id);
  console.log("Name:", asset.state.name);
  console.log("Resource version:", asset.state.resources[0].version);
  console.log("Local history and bytes verified:", verification.verified);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
