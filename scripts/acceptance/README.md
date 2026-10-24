# Local release acceptance (issue #976, section A)

```sh
bun run acceptance:local            # build, then run every phase
node scripts/acceptance/local-release.mjs [--out <dir>] [--receipt <file>] [--require-os-sandbox]
```

The orchestrator runs each phase as a separate, fresh OS process. Each phase
gets its own HOME, TMPDIR and working directory, an environment holding only
`PATH`, and only the directories it needs. The network is off in every phase,
in two layers:

- OS level: macOS `sandbox-exec` with `(deny network*)`, or Linux
  `unshare -rn`. When neither is available the receipt records
  `osNetworkBlock: "none"`. Pass `--require-os-sandbox` to fail in that case.
- In process: `lib/guard.mjs` is preloaded and makes `fetch`, `net`, `tls`,
  `http(s)` and `dns` throw.

Each phase probes both layers and records the result.

| Phase | Runtime | Has | Does |
|---|---|---|---|
| 0 author identity | Bun | custody, public | Mints the author's did:webvh with the landing's own `buildUserWebVHDid` and `BrowserWebVHSigner`, the #964 path. `#key-0` is the update key and `#key-1` the only assertionMethod. The secrets go only to `custody/author-keys.json`. |
| 1 author client A | Node | custody, public, store A | FileStore A. Creates an Original with `image/png`, `application/octet-stream` and `text/markdown` resources, then revises the text and the image, adds a resource and removes it again (P4.1; originals-spec #49). An editor's addition or removal, a reused resourceID and removing the last resource are refused before signing (P4.1, P5.16). Exports `original-A.zip` and the public claims in `expected-A.json`. |
| 2 offline reader | Node | the package only | Can't read the custody file or the stores (the sandbox denies reads, and the directories are `chmod 000`). Has no store and no key. Verifies the Original, the checkpoint, every historical checkpoint and every byte. Reports verified, valid as of its checkpoint (never current: it is not anchored, P7.10), freshness and ordering separately. Also runs the `originals verify --json` CLI. |
| 3 author client B | Node | custody, store B | Imports into an empty FileStore B. Importing gives no authority: with no signer, an intruder key or the update key, the edit fails. Neither secret appears in the package or in the store. With the authorship key supplied from custody, it continues from the explicit parent and keeps the did:vh and the versionId prefix. Then the stale-parent and stale-digest cases. |
| 4 negatives | Node | custody, store C | Missing historical bytes, both as store loss and as a stripped archive. A stale prefix. Divergent history: a later, longer branch signed from an earlier checkpoint, imported in both orders. That is an unresolved fork with no current branch. |

The phases use only built public entry points: `@originals/sdk/originals`,
`@originals/sdk/originals/fs` and `@originals/vh/*`. The one exception is
phase 0, which imports the landing's DID builder from source. Run
`bun run build` first, or use `acceptance:local`.

The receipt (`<out>/receipt.json`, also printed to stdout) records:

- the source SHA and dirty state, plus package and runtime versions
- the profile and signer mode
- per-phase isolation facts: pid, dirs, environment names, sandbox profile and network probes
- PASS/FAIL for every check, with the gates mapped to the section A checklist
- SHA-256 digests of every artifact

The orchestrator exits 1 on any failure.

Out of scope: section B (Turnkey, a public host, browser restart and
interrupted publication) and Bitcoin.
