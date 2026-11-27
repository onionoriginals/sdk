# did:og PNG/MP4 handoff kit

Two did:og Originals, one around a real photograph (PNG) and one around a real video clip (MP4).
Each is an evidence-package ZIP that verifies offline with the SDK's own did:og verifier.

- **SDK commit:** `c9c5880b066745ab9f8b4d1634ade2372256e25b` (onionoriginals/sdk). The kit was built
  and verified from a checkout of exactly that commit; this directory is the only addition.
- **Method:** `og:1.0-draft.1`. **Package format:** `originals-evidence/0.1` (P14.10).
- **Not anchored on Bitcoin.** Each Original is a single genesis entry. Nothing was broadcast,
  published, deployed or released.

## Media

Both files are openly licensed real camera footage from Wikimedia Commons. Their licences were
read from each file's Commons metadata (`LicenseShortName`, `Artist`), and the downloads match
Commons' SHA-1. Nothing comes from anyone's personal files.

| | Photo (PNG) | Video (MP4) |
|---|---|---|
| Kit file | `media/mars-curiosity-hazcam-2012-08-07.png` | `media/pangong-tso-waves-720p.mp4` |
| Source | <https://commons.wikimedia.org/wiki/File:Landscape-MarsCuriosity.png> | <https://commons.wikimedia.org/wiki/File:Pangong_Tso_Waves.webm> |
| Original file | <https://upload.wikimedia.org/wikipedia/commons/4/4d/Landscape-MarsCuriosity.png> | <https://upload.wikimedia.org/wikipedia/commons/7/71/Pangong_Tso_Waves.webm> |
| Author | NASA/JPL-Caltech | Satalah (Commons user; "own work") |
| Licence | Public domain (PD-NASA: a NASA work, not copyrighted in the US) | CC0 1.0 Universal (public domain dedication) |
| Commons SHA-1 | `16b9bc9885ba01b5860f5e36307a11049f685fd6` | `87cb5ffa73dfa9ba914d7d0b20503f3ad3583938` |
| What it is | One of the first images from Curiosity's rear Hazard-Avoidance camera, Gale Crater, Mars, 2012-08-07. NASA linearised it from the fisheye lens. | Small waves on the sandy shore of Pangong Tso, Ladakh, July 2021 |
| As packaged | The Commons file, **unmodified**: 1024×930 RGB PNG, 587,443 bytes | **Transcoded** from the Commons WebM (VP9, 1920×1080, 30 fps, 3.8 s, no audio) to H.264 High, 1280×720, 30 fps, all 3.8 s and 114 frames, no audio: 3,630,532 bytes |

The MP4 has to be a conversion: Commons doesn't host MP4. It was made with ffmpeg 9.0.2:

```sh
ffmpeg -i Pangong_Tso_Waves.webm -vf "scale=1280:720:flags=lanczos" -c:v libx264 -preset slow -crf 22 \
  -pix_fmt yuv420p -profile:v high -threads 1 -an -movflags +faststart \
  -map_metadata -1 -fflags +bitexact -flags:v +bitexact pangong-tso-waves-720p.mp4
```

Each Original's signed asset `metadata` names its source URL, author and licence.

## Files

| File | What it is |
|---|---|
| `did-og-png-evidence.zip`, `did-og-mp4-evidence.zip` | The evidence packages |
| `<zip>.sha256` | SHA-256 of the ZIP (`shasum -a 256 -c` from this directory) |
| `<zip>.contents.sha256` | SHA-256 of each file inside the ZIP, by its path in the ZIP (`shasum -a 256 -c` from a directory the ZIP is unpacked into) |
| `SHA256SUMS` | SHA-256 of every file in this directory |
| `media/` | The photo and the video, as packaged |
| `kit.json` | The DIDs, versionIds, digests and manifests the build produced |
| `verifier-output.txt` | Full output of the offline verification, with each report |
| `negative-checks-output.txt` | Full output of the tamper tests |
| `build-kit.ts`, `verify-kit.ts`, `negative-checks.ts` | The scripts that made and checked all of the above |

Each ZIP holds only the members P14.10 defines, and no checksum file:

```
asset/did.jsonl                                  the did:og asset log (the Original's history)
originals-evidence.json                          the manifest (completeness: complete, missing: [])
resources/<digest>                               the photo or the video, byte for byte the file in media/
signers/<sha256 of the author DID>/did.jsonl     the author's did:webvh log
```

The asset log is the did:og history. The only DID it depends on is the author's did:webvh, packaged
under `signers/`. There are no editors and no did:btco signers. Each ZIP is exactly the archive
`buildPackage` returns, in the canonical P14.10 byte form (`verify-kit.ts` checks this).

## The Originals

| | PNG | MP4 |
|---|---|---|
| did:og | `did:og:QmPwutjnV1PoiVnLmpJnxT1y7ko11HfLRbnYur1cPMydy3` | `did:og:QmPjvSn6gPBX14Vz1EPac5oRVsRHoBPfx1xvToc98L1CWx` |
| versionId | `1-QmS13vt5vxFk5aEfTNvh7waeFyZQC5zgimfPdX2XYtjhQk` | `1-QmRu1Mykx28p3wJ6FC6AHCFJ5aMorYusQnXPPSqTLzkayi` |
| mediaType | `image/png` | `video/mp4` |
| resource digest | `zQmPJrHiXpBrYixJUce3vNYrrzrMznWgWDWVqggwLDKPGZr` | `zQmZ6Xjnd9HphxJYbSqEdTQHSxtfxM5Ev8F8mZPZZ5RvPDm` |

Author (both): `did:webvh:QmVKFZxQYpQN2KZxxcfKz287W7exDaxmBjbLwK6YhqS1AX:example.com:authors:og-handoff-kit`,
version `1-QmTcPVoFRUYmgp49uPsMELMFMgiYT9ngq6yhojKGMCNsGF`.

## SHA-256

```
50cbc3ca255287c62f1bff06318406ede8d6b9a0350f227c863c20992d93d319  did-og-png-evidence.zip
  a03bfff100e9329e2474c1fd940e754a7620c35cd9155331fe82f1016db42a10  asset/did.jsonl
  64728eef950e492548ac3fb01527a3a7f31df707c086cc422656a8593752c18d  originals-evidence.json
  0e659e474fcb324d1ffb189711bd273c4d66ac53f24d5003b4b7949cc110155d  resources/zQmPJrHiXpBrYixJUce3vNYrrzrMznWgWDWVqggwLDKPGZr
  a369468ca6e7e809f8dad94937847d5dda349741c11380635f2edd39815184fa  signers/6e897e66781c2a941fc403b98cd139f4eb7fafbd79997a0e3b5ecaa8a041225b/did.jsonl

5b1e3572e66962bc464cff6188b14fdc659d5f3133a13de706ebae2ed5f43ab5  did-og-mp4-evidence.zip
  521a433943e6f620cbb748c655ecbdf88435687f40dfa01104f9dbdd9a7b02cd  asset/did.jsonl
  505db1bfddbce69ff33f18708d60c597616d76caa9afa032ebc40b4225f01be2  originals-evidence.json
  9fd28aeeaa8711340d1fc18488ee0c596d9b0f326e83aa8c2863f7f7f2377444  resources/zQmZ6Xjnd9HphxJYbSqEdTQHSxtfxM5Ev8F8mZPZZ5RvPDm
  a369468ca6e7e809f8dad94937847d5dda349741c11380635f2edd39815184fa  signers/6e897e66781c2a941fc403b98cd139f4eb7fafbd79997a0e3b5ecaa8a041225b/did.jsonl
```

The signer log is the same file in both ZIPs, because both Originals have the same author.

## Verifying

From the repository root, at commit `c9c5880b066745ab9f8b4d1634ade2372256e25b` plus this directory:

```sh
bun install --frozen-lockfile
(cd handoff/did-og-png-mp4-kit && shasum -a 256 -c SHA256SUMS)
mkdir -p /tmp/png && unzip -o -q handoff/did-og-png-mp4-kit/did-og-png-evidence.zip -d /tmp/png \
  && (cd /tmp/png && shasum -a 256 -c "$OLDPWD/handoff/did-og-png-mp4-kit/did-og-png-evidence.zip.contents.sha256")
sandbox-exec -p '(version 1)(allow default)(deny network*)' bun handoff/did-og-png-mp4-kit/verify-kit.ts
sandbox-exec -p '(version 1)(allow default)(deny network*)' bun handoff/did-og-png-mp4-kit/negative-checks.ts
```

`sandbox-exec` (macOS) denies all networking to the process; on Linux, `unshare -rn` does the same.
Each saved output records a self-test: Bun's `fetch` refused inside the same sandbox. `verify-kit.ts`
also replaces `fetch` with a function that throws, and counts attempts (0). Each evidence set is
exactly one input: the ZIP, read from disk.

### Offline verification: PASS

See `verifier-output.txt` (39 checks pass, 0 fail, exit status 0). For both Originals:

| Axis | Value |
|---|---|
| outcome | `verified` |
| binding | `bound` |
| history | `valid` |
| identity | `complete`: the author's did:webvh history is checked from the package |
| authority | `current` |
| state | `valid-as-of` the genesis entry: an unanchored Original is never `current` (P7.10, P7.18) |
| availability | `complete`: the resource bytes are in the package and match their digest |
| offline | `self-contained` |
| bitcoin | `not-read`: no Bitcoin input and no anchor named (P7.18) |

There is one accepted entry each (authority `current-key`), and no diagnostics.

### Tamper tests: every tampered package FAILS

See `negative-checks-output.txt` (exit status 0). Each tamper is applied to an in-memory copy of
each ZIP and judged by the pass criteria above:

| Tamper | Result (PNG and MP4 alike) | Reason the verifier gives |
|---|---|---|
| 1. One byte of the media flipped | **FAIL** | `availability none`, `offline needs-external`, diagnostic `resource-mismatch` (P7.4): the bytes do not match the signed descriptor |
| 2. The did:og log entry altered (asset name in the genesis entry) | **FAIL** | `outcome invalid`, `binding unbound`, `history invalid`, `state none`; entry rejected under P14.28: the SCID is no longer the hash of the genesis entry |
| 3. The author's did:webvh log entry altered (its `versionTime`) | **FAIL** | `outcome incomplete`, `identity incomplete`; diagnostics `signer-history-missing` (P5.6) and `proof-unchecked` (P7.19); the entry is `unchecked` |
| 4. The signer history swapped for another valid did:webvh log, of a different DID | **FAIL** | the same as 3: `outcome incomplete`, `identity incomplete`, `signer-history-missing`, `proof-unchecked` |

Two things a consumer of these reports should know:

- **Check `availability`, not `outcome` alone.** With the media altered, the signed history is
  still intact, so `outcome` stays `verified`. The altered bytes are reported separately, as
  `availability: none` with `resource-mismatch` (P7.3, P7.4).
- **A bad or swapped signer log reads as missing, not forged.** The verifier uses a signer
  history only if it verifies as the named DID's own log. One that doesn't is no evidence for that
  signer (P5.6, P5.8), so 3 and 4 report the author's history as not in the evidence set, and the
  entry as `unchecked` (outcome `incomplete`), not as a bad signature.

## Limits

- **The package path is `@originals/vh/og`, not `OriginalsSDK.package()`/`load()`.** At this
  commit, `OriginalsSDK.package()` and `load()` (`@originals/sdk/originals`) write and read the
  earlier `originals:1.0` format, which a did:og verifier reports as `unsupported` (P14.1). The
  native did:og package is written by `buildPackage` and read by `verifyOriginal` (a `package`
  input), both in `@originals/vh/og`, with the author DID and genesis entries from
  `@originals/sdk/og` (`createAuthorDid`, `createGenesis`). No ZIP code was written for the kit.
- **The video was transcoded and scaled to make an MP4**, as described above. The photo is the
  Commons file, unmodified.
- **The author DID is not hosted.** `example.com` is a placeholder domain. Offline verification
  never fetches, so the packaged log is all that's needed; resolving the DID online would fail.
- **The keys are gone.** The author's keys, and the throwaway keys for tamper test 4, were
  generated into temporary directories outside the repository and deleted. Nothing more can be
  signed for these Originals; a rebuild makes new DIDs.
- **Not anchored.** `network` is `mainnet` in the asset state, but nothing was inscribed;
  `bitcoin: not-read` reflects that.
