# did:og PNG/MP4 handoff kit

Two did:og Originals, one around a real PNG and one around a real MP4, each as an evidence-package
ZIP that verifies offline with the SDK's own did:og verifier.

- **SDK commit:** `c9c5880b066745ab9f8b4d1634ade2372256e25b` (onionoriginals/sdk). Everything here was
  built and verified from a checkout of exactly that commit.
- **Method:** `og:1.0-draft.1`. **Package format:** `originals-evidence/0.1` (P14.10).
- **Not anchored on Bitcoin.** Each Original is a single genesis entry. Nothing was broadcast,
  published, deployed or released.

## Files

| File | What it is |
|---|---|
| `did-og-png-evidence.zip` | Evidence package for the PNG Original |
| `did-og-mp4-evidence.zip` | Evidence package for the MP4 Original |
| `*.zip.sha256` | SHA-256 of each ZIP (`sha256sum -c` format) |
| `SHA256SUMS` | SHA-256 of every file in this kit, including the ZIPs |
| `media/test-pattern-1280x720.png` | The PNG, as packaged (1280×720, 8-bit RGB) |
| `media/test-pattern-4s.mp4` | The MP4, as packaged (640×360, 4 s, H.264 + AAC, 25 fps) |
| `kit.json` | The DIDs, versionIds, digests and manifests the build produced |
| `verifier-output.txt` | Full output of the offline verification run, with each report |
| `negative-checks-output.txt` | Output of the tamper checks |
| `build-kit.ts`, `verify-kit.ts`, `negative-checks.ts` | The scripts that made and checked all of the above |

Each ZIP contains:

```
SHA256SUMS                                       SHA-256 of every other member
asset/did.jsonl                                  the did:og asset log (its history)
originals-evidence.json                          the manifest (completeness: complete, missing: [])
resources/<digest>                               the PNG or MP4 bytes
signers/<sha256 of the author DID>/did.jsonl     the author's did:webvh log
```

The asset log is the did:og history. The only other DID it depends on is the author's did:webvh,
whose log is packaged under `signers/`. There are no editors and no did:btco signers, so nothing
else is needed.

## The Originals

| | PNG | MP4 |
|---|---|---|
| did:og | `did:og:QmVhbTsUBUazRmzY7traJrmEde72fhwib5ZXAzDNQjS9JW` | `did:og:QmTD2bUxsR7NBnUcxfnChVUddMA3G3DK8V1qTCjroBsK2i` |
| versionId | `1-QmWSYacozGaQyzvn3aEU9qCzmEJ8Q1iKM7U7vaFg5BoFq6` | `1-QmW7vbWsUP1vk4kGZNkqQUhNLrqrzUvfpRypBt5xB9H5XF` |
| mediaType | `image/png` | `video/mp4` |
| size | 96,453 bytes | 422,871 bytes |
| resource digest | `zQmWPs48KpHyf87TumLjWe2CnBZXxCNgWMJX4Gc1tP1yc2r` | `zQmebLFSd3gKYZTQMp53U6ifUbNeGLVfGxKNV8Jtv87gUB9` |

Author (both): `did:webvh:QmXQ7agTs2JXgUxpMizieRC2Ky3xfZTY1G7ceEbFcSRunb:example.com:authors:og-handoff-kit`,
version `1-QmeYCqsiWDShFTRWmXNTQf6ZXsxFhR7bU5vaLoQ569WfcZ`.

## SHA-256

ZIPs:

```
0de1ef68c16ebdfd9c0cb73a6b0c921bfed65589043b44a6c63a15c6a056466c  did-og-png-evidence.zip
e5cb119f47922d9e760344f6532019aa517ff7f0d816d452cf07d55d35ac7d51  did-og-mp4-evidence.zip
```

Members of `did-og-png-evidence.zip`:

```
1aeccffb0f620afcb7f5becebdc9a576788706618515cbe90d5407798728aba1  SHA256SUMS
9ce1c556454b148e02d3f4d3c24ba2bb2d0ec31cc7bd6c6c204e9eded3a3d84f  asset/did.jsonl
4a1d70118434b7de726497525aae7a23bd021f6a567f81fdce20fde9fb9b01d0  originals-evidence.json
77b03252ee8f7cbfcfa3013c6a9cc9c3e95235be40ad162835d87c1a165bd497  resources/zQmWPs48KpHyf87TumLjWe2CnBZXxCNgWMJX4Gc1tP1yc2r
bbbfb43d8637c963d6c38bad329b651a27ebf67441af1a10e44d6f8a49dabe9f  signers/87bec4d6a935fac3a83141696a642bd97ab654d74e19039b5668693c61ba7a8d/did.jsonl
```

Members of `did-og-mp4-evidence.zip`:

```
6d09101c4a01d749598f5ace315a8f5abf3f3dfe9920f7afae5fd013749daee0  SHA256SUMS
2121bdad17a7264bf910bfa75b3ac9940fe68fdbdee2784f3329f5a773cfb95f  asset/did.jsonl
a3dbea80580dfada931d3573b6713158623c4c1cb41ebb7c9cd1a8c20be4f6d7  originals-evidence.json
f17dd49a5130877b2bd43c07406d366553604df0e04d6dbc9a770842b9fb68b0  resources/zQmebLFSd3gKYZTQMp53U6ifUbNeGLVfGxKNV8Jtv87gUB9
bbbfb43d8637c963d6c38bad329b651a27ebf67441af1a10e44d6f8a49dabe9f  signers/87bec4d6a935fac3a83141696a642bd97ab654d74e19039b5668693c61ba7a8d/did.jsonl
```

The `SHA256SUMS` member cannot list its own hash; it is given above. The signer log is the same
file in both ZIPs, since both Originals have the same author.

## How the media were made

ffmpeg 9.0.2 (libx264, native AAC), then the PNG renamed:

```sh
ffmpeg -f lavfi -i "testsrc2=size=1280x720:rate=1" -frames:v 1 -pix_fmt rgb24 \
  -map_metadata -1 -fflags +bitexact -flags +bitexact test-pattern-1280x720.png
ffmpeg -f lavfi -i "testsrc2=size=640x360:rate=25:duration=4" -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=4" \
  -c:v libx264 -preset medium -crf 23 -pix_fmt yuv420p -threads 1 -c:a aac -b:a 96k -shortest -movflags +faststart \
  -map_metadata -1 -fflags +bitexact -flags:v +bitexact -flags:a +bitexact test-pattern-4s.mp4
```

The kit's files are the ones listed in `SHA256SUMS`; a re-render on another ffmpeg build may differ.

## Verifying

From the repository root, at commit `c9c5880b066745ab9f8b4d1634ade2372256e25b`:

```sh
bun install --frozen-lockfile
(cd handoff/did-og-png-mp4-kit && shasum -a 256 -c SHA256SUMS)
sandbox-exec -p '(version 1)(allow default)(deny network*)' bun handoff/did-og-png-mp4-kit/verify-kit.ts
sandbox-exec -p '(version 1)(allow default)(deny network*)' bun handoff/did-og-png-mp4-kit/negative-checks.ts
```

`sandbox-exec` (macOS) denies all networking to the process; on Linux, `unshare -rn` does the same.
`verify-kit.ts` also replaces `fetch` with a function that throws, and counts attempts (0 in the
saved run). Each evidence set is exactly one input: the ZIP, read from disk.

**Result: PASS** (`verifier-output.txt`, exit status 0). For both Originals:

| Axis | Value |
|---|---|
| outcome | `verified` |
| binding | `bound` |
| history | `valid` |
| identity | `complete`: the author's did:webvh history is checked from the package |
| authority | `current` |
| state | `valid-as-of` the genesis entry: an unanchored Original is never `current` (P7.10, P7.18) |
| availability | `complete`: the resource bytes are in the package |
| offline | `self-contained` |
| bitcoin | `not-read`: no Bitcoin input and no anchor named (P7.18) |

There is one accepted entry each (authority `current-key`), and no diagnostics.

**Check `availability`, not only `outcome`.** `negative-checks.ts` flips one bit of the packaged
PNG. The signed history is still intact, so `outcome` stays `verified`, but `availability` becomes
`none` with a `resource-mismatch` diagnostic (resource availability is reported separately, P7.3,
P7.4). Swapping the author's key in the packaged did:webvh log gives `identity: incomplete`,
`outcome: incomplete`. Both are in `negative-checks-output.txt`.

## Deviations and limits

- **The package path is `@originals/vh/og`, not `OriginalsSDK.package()`/`load()`.** At this
  commit, `OriginalsSDK.package()` and `load()` (`@originals/sdk/originals`) write and read the
  earlier `originals:1.0` format, which a did:og verifier reports as `unsupported` (P14.1). The
  native did:og package is written by `buildPackage` and read by `verifyOriginal` (as a `package`
  input), both in `@originals/vh/og`, with the author DID and genesis entries from
  `@originals/sdk/og` (`createAuthorDid`, `createGenesis`). No ZIP code was written for the kit.
- **`SHA256SUMS` inside each ZIP is an extra member.** P14.10 lists a package's members and does
  not name it. The ZIPs are written by the SDK's own deterministic writer (`writePackageZip`, the
  one `buildPackage` uses), so the format is unchanged. The verifier ignores the member, and
  `verify-kit.ts` checks that the same package without it gives the same report. A stricter
  reader could reject an unlisted member. Without `SHA256SUMS`, each ZIP would be byte for byte
  what `buildPackage` writes.
- **The author DID is not hosted.** `example.com` is a placeholder domain. Offline verification
  never fetches, so the packaged log is all that's needed; resolving the DID online would fail.
- **The keys are gone.** The author's keys were generated into a temporary directory outside the
  repository and deleted after the build. Nothing more can be signed for these Originals; a
  rebuild makes new DIDs.
- **The media are synthetic test patterns.** Real PNG and real MP4 files rendered by ffmpeg
  (`testsrc2`, plus a 440 Hz sine tone for the audio), not photographs or footage.
- **Not anchored.** `network` is `mainnet` in the asset state, but nothing was inscribed;
  `bitcoin: not-read` reflects that.
