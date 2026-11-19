# Bitcoin previews on regtest, 2026-11-18

Plan 011 phase 12b (originals-spec PR 64 at `940c6d4`; P9.17, P9.18, P9.30,
P14.12). Journey: [`scripts/regtest/originals-preview.ts`](../../scripts/regtest/originals-preview.ts),
run by `bun run regtest` with every other journey (all passed). Disposable
regtest only: no mainnet or testnet activity.

- Bitcoin Core: `Bitcoin Core daemon version v31.1.0 bitcoind`
- ord: `ord 0.29.0`
- Receipt: [`receipts/originals-preview-2026-11-18.json`](receipts/originals-preview-2026-11-18.json)

## Originals

- Image Original `did:vh:QmRjuvfhscqmMAE9AVtQC8BffNztoq67ZrLii56v6tVRNi` on `did:btco:reg:5000000000`: version 1 a
  640×480 PNG of 372,751 bytes; its preview
  `zQmX2Ry7RVZM1dEJDhwnWggkpXhPCRCP3hVZ82qKiRttEMF`, a 256×192
  WebP at quality 50, 6,790 bytes. Version 2 a 160×120
  PNG of 43,592 bytes; its preview `zQmNPvmSeC33dzTKtR7GFQZ1Gxrx7Do3icf4Kf8A8At2KWQ`,
  7,392 bytes.
- Text Original `did:vh:QmSE5277tncckQee85uK4e3uMmNGzZa78NZ7XSjU9sanYL` on `did:btco:reg:5001100000`: `text/markdown`, no
  preview at the anchor; version 2 with the author's `text/plain` preview of
  21 bytes.

## Inscriptions (fee rate 1 sat/vB)

| Step | Entry | Inscription | Body | ord content type | ord content length | Fees, sats (commit + reveal) |
| --- | --- | --- | --- | --- | --- | --- |
| 1. anchor, image with a generated preview | `2-QmW9phm6SXXMRQYGBbPDy6gUyuT8sXDostSRb1wjc66zSE` | `267a69978ec3fc38c7170fff1739250561b822c418ccea75e6fc24f2430adbf4i0` | preview | image/webp | 6790 | 2818 (244 + 2574) |
| 2. name-only edit, same preview | `3-QmaxQrX7ZP5kaa6t2err6BdBGd9AxK7rZPYhdLN4oKvwF3` | `8ad2f2fe7ea45fea2890933c382ff53b8ef0aeb7a26a3f1e624df14090e7f316i0` | preview | image/webp | 6790 | 2556 (244 + 2312) |
| 3. new image version, new preview | `4-QmUzdzCKgsfG4BmisuapMo7zhxhifKRAdNUUtfjV1bYXbT` | `45ef56f0a6825193922c5ea8612062aacbb56e7c12f9fc362234e3f503d5899di0` | preview | image/webp | 7392 | 2751 (244 + 2507) |
| 4. name-only edit, full version chosen | `5-QmRqunu8Esbh9GkgJaVyQ3m97Dj4jeA2uo2VivZYD5bSBg` | `baac7cbe2134f9ced8ba0e1762cdca1d0efa43bdf875ad545dd12de72d56de4di0` | full | image/png | 43592 | 12704 (244 + 12460) |
| 5a. text Original anchored, no preview: no body | `2-QmPZwhUZ5m1ymmWA3XdLn7Pr1ptddtYRcNphgEAbiHpALq` | `54edc86b95574503e8d57ad0abe4361dad6310155864d525879731d4f7ec5021i0` | none | (none) | null | 910 (244 + 666) |
| 5b. new text version, author's text/plain preview | `3-QmdHLUCfLwUc4TUaiSjtWy3o1Cfm94QMPg3juuX8PBXnUA` | `a34cb682f2982f2fbad038291e4ccd852454873ff4f373e9b1364852e050c736i0` | preview | text/plain | 21 | 709 (244 + 465) |

Each inscription's metadata, as ord serves it from `/r/metadata`, decodes to
exactly the entries the pair carries. The preview bodies are byte for byte the
previews the entries name (by digest), and the full-version body is the PNG.
The anchoring inscription with a 6.8 kB preview cost 2,818 sats in fees,
in line with the owner's estimate of about 2,500 sats for an 8 kB preview at
1 sat/vB, whatever the size of the version (a 373 kB PNG here).

## The inscription with no body (step 5a)

The writer left out ord's body push. ord 0.29.0 indexes it as an inscription
on the sat with `content_length: null` and `content_type: null`, answers
`/content/<id>` with 404, and serves its metadata. The SDK's sat
reader reports it as `noBody`, and the verifier accepts it as the anchor with
body `none`.

## Fresh readers (step 6)

Given only the sats and the author's did:vh history:

- Image Original: anchored and current at `5-QmRqunu8Esbh9GkgJaVyQ3m97Dj4jeA2uo2VivZYD5bSBg`; bodies
  preview, preview, preview, version; version 1 `missing` (known only by its
  preview, never verified by it), version 2 `verified` from Bitcoin
  (inscribed in full in step 4).
- Text Original: anchored and current at `3-QmdHLUCfLwUc4TUaiSjtWy3o1Cfm94QMPg3juuX8PBXnUA`; bodies
  none, preview; both versions `missing` (no body, then a preview).

## Other journeys in the same run

`originals-anchor.ts`, `originals-restart.ts` and `landing-anchor.ts` now
inscribe the full version explicitly (`body: "full"`), as before previews, and
passed unchanged otherwise; the landing keeps inscribing full versions until
its copy and browser SVG rasteriser are wired (a follow-up).
