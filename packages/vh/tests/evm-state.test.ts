/**
 * EVM anchoring, the state rules (originals-spec PR 59, proposed, EXPERIMENTAL):
 * the anchor member (P14.18), its carry rule (P9.19), the token alias (P14.18,
 * P14.19), did:btco signers (P9.26) and move entries (P9.28).
 */
import { describe, expect, test } from "bun:test";
import { OriginalsError } from "../src/errors.js";
import {
  EVM_CHAINS,
  caip19Of,
  checkAnchor,
  createOriginal,
  derivedTokenAlias,
  evmSupport,
  parseEvmAlias,
  tokenIdOf,
  updateOriginal,
  type EvmAnchorPin,
} from "../src/originals/index.js";
import { VhAuthor, clock, photo, seeded } from "./helpers/originals.js";

const PIN: EvmAnchorPin = { address: "0x" + "ab".repeat(20), codeHash: "0x" + "00".repeat(32) };
const ROBINHOOD = "eip155:4663"; // operator: attested
const TEMPO = "eip155:4217"; // consortium: attested
const ETHEREUM = "eip155:1"; // consensus: proven
const BASE = "eip155:8453"; // exit-protected: proven
const A = "0x" + "11".repeat(20);
const C = "0x" + "22".repeat(20);

async function rejects(p: Promise<unknown>, code: string, category = "invalid-evidence") {
  try {
    await p;
  } catch (error) {
    expect(error).toBeInstanceOf(OriginalsError);
    expect((error as OriginalsError).code).toBe(code);
    expect((error as OriginalsError).category).toBe(category);
    return;
  }
  throw new Error(`expected ${code}`);
}

async function anchoredOn(chain: string) {
  const key = seeded(31);
  const alice = await VhAuthor.create([{ fragment: "orig", signer: key }]);
  const at = clock();
  const sign = alice.signer(key, "orig");
  const author = alice.ref("orig");
  const genesis = await createOriginal({ versionTime: at(), name: "Harbor at dusk", resource: photo("dusk"), author, sign, anchor: { chain, minter: A }, evm: PIN });
  const id = (genesis.state as { id: string }).id;
  const token = derivedTokenAlias(id, { chain, minter: A }, PIN);
  const anchoring = await updateOriginal(genesis, { versionTime: at(), author, sign, aliases: [token], evm: PIN });
  return { alice, at, sign, author, genesis, anchoring, id, token };
}

describe("P14.18 the anchor member and token alias", () => {
  test("PR59: anchor.chain not eip155 with a canonical decimal chain ID / minter in mixed case: rejected", () => {
    for (const chain of ["eip155:01", "eip155:0", "cosmos:1", "eip155:18446744073709551616", "eip155:1a"]) {
      expect(() => checkAnchor({ chain, minter: A })).toThrow(/P14.18/);
    }
    expect(() => checkAnchor({ chain: "eip155:1", minter: "0x" + "Ab".repeat(20) })).toThrow(/lowercase/);
    expect(() => checkAnchor({ chain: "eip155:1", minter: A, extra: 1 })).toThrow(/exactly/);
    expect(checkAnchor({ chain: "eip155:18446744073709551615", minter: A }).chain).toBe("eip155:18446744073709551615");
  });

  test("did:evm form; CAIP-19 derived, never an alias", () => {
    const alias = `did:evm:1:${PIN.address}:12345`;
    expect(parseEvmAlias(alias)).toEqual({ chain: "eip155:1", contract: PIN.address, tokenId: 12345n });
    expect(caip19Of(alias)).toBe(`eip155:1/erc721:${PIN.address}/12345`);
    for (const bad of [`did:evm:01:${PIN.address}:1`, `did:evm:1:${PIN.address.toUpperCase()}:1`, `did:evm:1:${PIN.address}:01`, `did:evm:eip155:1:${PIN.address}:1`]) {
      expect(() => parseEvmAlias(bad)).toThrow(/P14.18/);
    }
  });

  test("P14.19 token ID is keccak256(abi.encode(keccak256(did:vh), minter))", () => {
    // Cross-checked against Solidity in the contract tests; here: depends on both inputs.
    const did = "did:vh:QmTestTestTestTestTestTestTestTestTestTestTest";
    expect(tokenIdOf(did, A)).not.toBe(tokenIdOf(did, C));
    expect(tokenIdOf(did, A)).toBe(tokenIdOf(did, A));
    expect(tokenIdOf(did, A) < 1n << 256n).toBe(true);
  });

  test("PR59: genesis with an anchor member while P14.21 pins no contract: a writer refuses", async () => {
    const key = seeded(32);
    const alice = await VhAuthor.create([{ fragment: "orig", signer: key }]);
    await rejects(
      createOriginal({ versionTime: clock()(), name: "x", resource: photo("x"), author: alice.ref("orig"), sign: alice.signer(key, "orig"), anchor: { chain: ETHEREUM, minter: A } }),
      "EVM_NO_ANCHOR_CONTRACT",
      "unsupported-profile",
    );
    expect(evmSupport(ETHEREUM)).toEqual({ supported: false, reason: "no-anchor-contract-pinned" });
  });

  test("PR59: anchor.chain well formed but not listed: unsupported; a writer refuses", async () => {
    const key = seeded(33);
    const alice = await VhAuthor.create([{ fragment: "orig", signer: key }]);
    await rejects(
      createOriginal({ versionTime: clock()(), name: "x", resource: photo("x"), author: alice.ref("orig"), sign: alice.signer(key, "orig"), anchor: { chain: "eip155:10", minter: A }, evm: PIN }),
      "EVM_CHAIN_NOT_LISTED",
      "unsupported-profile",
    );
    expect(evmSupport("eip155:10", PIN)).toEqual({ supported: false, reason: "chain-not-listed" });
    expect(EVM_CHAINS.map((c) => c.chain)).toEqual(["eip155:1", "eip155:143", "eip155:8453", "eip155:42161", "eip155:5042", "eip155:4217", "eip155:4663", "eip155:99901"]);
  });
});

describe("P9.19 the anchor member is fixed at genesis", () => {
  test("PR59: Original without anchor whose later entry adds one; with anchor whose non-move entry changes or removes it: rejected", async () => {
    const key = seeded(34);
    const alice = await VhAuthor.create([{ fragment: "orig", signer: key }]);
    const at = clock();
    const sign = alice.signer(key, "orig");
    const author = alice.ref("orig");
    const plain = await createOriginal({ versionTime: at(), name: "x", resource: photo("x"), author, sign });
    await rejects(updateOriginal(plain, { versionTime: at(), author, sign, anchor: { chain: ETHEREUM, minter: A }, evm: PIN }), "STATE_ANCHOR");
    const { genesis, author: au, sign: s2, at: at2 } = await anchoredOn(ROBINHOOD);
    // Not anchored yet: a change is a move before the anchoring entry.
    await rejects(updateOriginal(genesis, { versionTime: at2(), author: au, sign: s2, anchor: { chain: ROBINHOOD, minter: C }, evm: PIN }), "STATE_MOVE_BEFORE_ANCHOR");
    await rejects(updateOriginal(genesis, { versionTime: at2(), author: au, sign: s2, anchor: null, evm: PIN }), "STATE_MOVE_BEFORE_ANCHOR");
  });

  test("PR59: EVM anchor listing a did:btco alias, or another token's alias; no anchor listing a token alias: rejected", async () => {
    const { genesis, author, sign, at, id } = await anchoredOn(ROBINHOOD);
    await rejects(updateOriginal(genesis, { versionTime: at(), author, sign, aliases: ["did:btco:reg:1234"], evm: PIN }), "STATE_ALIASES");
    const other = derivedTokenAlias(id, { chain: ROBINHOOD, minter: C }, PIN);
    await rejects(updateOriginal(genesis, { versionTime: at(), author, sign, aliases: [other], evm: PIN }), "STATE_ANCHOR_TOKEN");
    const wrongContract = `did:evm:4663:0x${"cd".repeat(20)}:${tokenIdOf(id, A)}`;
    await rejects(updateOriginal(genesis, { versionTime: at(), author, sign, aliases: [wrongContract], evm: PIN }), "STATE_ANCHOR_TOKEN");
    const key = seeded(35);
    const bob = await VhAuthor.create([{ fragment: "orig", signer: key }]);
    const plain = await createOriginal({ versionTime: at(), name: "x", resource: photo("x"), author: bob.ref("orig"), sign: bob.signer(key, "orig") });
    await rejects(updateOriginal(plain, { versionTime: at(), author: bob.ref("orig"), sign: bob.signer(key, "orig"), aliases: [`did:evm:1:${PIN.address}:1`] }), "STATE_ALIASES");
  });

  test("anchored on a token: the token alias stays until a move entry; no did:webvh added (P9.10 via P9.20)", async () => {
    const { anchoring, author, sign, at } = await anchoredOn(ROBINHOOD);
    await rejects(updateOriginal(anchoring, { versionTime: at(), author, sign, aliases: [], evm: PIN }), "STATE_ANCHOR");
    const renamed = await updateOriginal(anchoring, { versionTime: at(), author, sign, name: "Renamed", evm: PIN });
    expect((renamed.state as { asset: { anchor: unknown } }).asset.anchor).toEqual({ chain: ROBINHOOD, minter: A });
  });
});

describe("P9.28 move entries", () => {
  test("PR59: move from an attested chain to a proven chain, or to Bitcoin; from a proven chain to Bitcoin: accepted by the state rules", async () => {
    const { anchoring, author, sign, at, id } = await anchoredOn(ROBINHOOD);
    const dest = derivedTokenAlias(id, { chain: ETHEREUM, minter: C }, PIN);
    const moved = await updateOriginal(anchoring, { versionTime: at(), author, sign, anchor: { chain: ETHEREUM, minter: C }, aliases: [dest], evm: PIN });
    expect((moved.state as { asset: { aliases: string[] } }).asset.aliases).toEqual([dest]);
    const toBitcoin = await updateOriginal(anchoring, { versionTime: at(), author, sign, anchor: null, aliases: ["did:btco:reg:1234"], evm: PIN });
    expect((toBitcoin.state as { asset: { anchor?: unknown } }).asset.anchor).toBeUndefined();
    const proven = await anchoredOn(BASE);
    await updateOriginal(proven.anchoring, { versionTime: proven.at(), author: proven.author, sign: proven.sign, anchor: null, aliases: ["did:btco:reg:99"], evm: PIN });
  });

  test("PR59: move to a chain in the same layer or a lower one: rejected", async () => {
    const attested = await anchoredOn(ROBINHOOD);
    const toTempo = derivedTokenAlias(attested.id, { chain: TEMPO, minter: C }, PIN);
    await rejects(updateOriginal(attested.anchoring, { versionTime: attested.at(), author: attested.author, sign: attested.sign, anchor: { chain: TEMPO, minter: C }, aliases: [toTempo], evm: PIN }), "STATE_MOVE_LAYER");
    const proven = await anchoredOn(ETHEREUM);
    const down = derivedTokenAlias(proven.id, { chain: ROBINHOOD, minter: C }, PIN);
    await rejects(updateOriginal(proven.anchoring, { versionTime: proven.at(), author: proven.author, sign: proven.sign, anchor: { chain: ROBINHOOD, minter: C }, aliases: [down], evm: PIN }), "STATE_MOVE_LAYER");
    const side = derivedTokenAlias(proven.id, { chain: BASE, minter: C }, PIN);
    await rejects(updateOriginal(proven.anchoring, { versionTime: proven.at(), author: proven.author, sign: proven.sign, anchor: { chain: BASE, minter: C }, aliases: [side], evm: PIN }), "STATE_MOVE_LAYER");
  });

  test("PR59: entry that changes anchor without listing the destination's alias: rejected", async () => {
    const { anchoring, author, sign, at, token } = await anchoredOn(ROBINHOOD);
    await rejects(updateOriginal(anchoring, { versionTime: at(), author, sign, anchor: { chain: ETHEREUM, minter: C }, aliases: [], evm: PIN }), "STATE_MOVE_ALIAS");
    await rejects(updateOriginal(anchoring, { versionTime: at(), author, sign, anchor: null, aliases: [], evm: PIN }), "STATE_MOVE_ALIAS");
    // Keeping the old token alias is not listing the destination's: it is on another chain.
    await rejects(updateOriginal(anchoring, { versionTime: at(), author, sign, anchor: { chain: ETHEREUM, minter: C }, aliases: [token], evm: PIN }), "STATE_ALIASES");
  });

  test("PR59: move entry to a chain the verifier's P14.22 does not list: unsupported, not invalid", async () => {
    const { anchoring, author, sign, at, id } = await anchoredOn(ROBINHOOD);
    const pin10: EvmAnchorPin = { ...PIN };
    const dest = `did:evm:10:${PIN.address}:${tokenIdOf(id, C)}`;
    // The writer refuses first (P9.19).
    await rejects(updateOriginal(anchoring, { versionTime: at(), author, sign, anchor: { chain: "eip155:10", minter: C }, aliases: [dest], evm: pin10 }), "EVM_CHAIN_NOT_LISTED", "unsupported-profile");
  });
});

describe("P9.26 no did:btco signers with an anchor member", () => {
  test("PR59: Original with an EVM anchor naming a did:btco author or editor: rejected", async () => {
    const { genesis, author, sign, at } = await anchoredOn(ROBINHOOD);
    await rejects(updateOriginal(genesis, { versionTime: at(), author, sign, editors: [{ did: "did:btco:reg:5", name: true, metadata: false, resource: false }], evm: PIN }), "STATE_ANCHOR_BTCO_SIGNER");
  });
});
