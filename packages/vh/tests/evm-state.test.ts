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
  checkEditorChange,
  checkEntryState,
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
  test("C12-237: anchor.chain not eip155 with a canonical decimal chain ID / minter in mixed case: rejected", () => {
    for (const chain of ["eip155:01", "eip155:0", "cosmos:1", "eip155:18446744073709551616", "eip155:1a"]) {
      expect(() => checkAnchor({ chain, minter: A })).toThrow(/P14.18/);
    }
    expect(() => checkAnchor({ chain: "eip155:1", minter: "0x" + "Ab".repeat(20) })).toThrow(/lowercase/);
    expect(() => checkAnchor({ chain: "eip155:1", minter: A, extra: 1 })).toThrow(/exactly/);
    expect(checkAnchor({ chain: "eip155:18446744073709551615", minter: A }).chain).toBe("eip155:18446744073709551615");
  });

  test("C12-282: did:evm form; CAIP-19 derived, never an alias", () => {
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

  test("C12-239: genesis with an anchor member while P14.21 pins no contract: a writer refuses", async () => {
    const key = seeded(32);
    const alice = await VhAuthor.create([{ fragment: "orig", signer: key }]);
    await rejects(
      createOriginal({ versionTime: clock()(), name: "x", resource: photo("x"), author: alice.ref("orig"), sign: alice.signer(key, "orig"), anchor: { chain: ETHEREUM, minter: A } }),
      "EVM_NO_ANCHOR_CONTRACT",
      "unsupported-profile",
    );
    expect(evmSupport(ETHEREUM)).toEqual({ supported: false, reason: "no-anchor-contract-pinned" });
  });

  test("C12-238: anchor.chain well formed but not listed: unsupported; a writer refuses", async () => {
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
  test("C12-235: Original without anchor whose later entry adds one; with anchor whose non-move entry changes or removes it: rejected", async () => {
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

  test("C12-236: EVM anchor listing a did:btco alias, or another token's alias; no anchor listing a token alias: rejected", async () => {
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
  test("C12-265: move from an attested chain to a proven chain, or to Bitcoin; from a proven chain to Bitcoin: accepted by the state rules", async () => {
    const { anchoring, author, sign, at, id } = await anchoredOn(ROBINHOOD);
    const dest = derivedTokenAlias(id, { chain: ETHEREUM, minter: C }, PIN);
    const moved = await updateOriginal(anchoring, { versionTime: at(), author, sign, anchor: { chain: ETHEREUM, minter: C }, aliases: [dest], evm: PIN });
    expect((moved.state as { asset: { aliases: string[] } }).asset.aliases).toEqual([dest]);
    const toBitcoin = await updateOriginal(anchoring, { versionTime: at(), author, sign, anchor: null, aliases: ["did:btco:reg:1234"], evm: PIN });
    expect((toBitcoin.state as { asset: { anchor?: unknown } }).asset.anchor).toBeUndefined();
    const proven = await anchoredOn(BASE);
    await updateOriginal(proven.anchoring, { versionTime: proven.at(), author: proven.author, sign: proven.sign, anchor: null, aliases: ["did:btco:reg:99"], evm: PIN });
  });

  test("C12-266: move to a chain in the same layer or a lower one: rejected", async () => {
    const attested = await anchoredOn(ROBINHOOD);
    const toTempo = derivedTokenAlias(attested.id, { chain: TEMPO, minter: C }, PIN);
    await rejects(updateOriginal(attested.anchoring, { versionTime: attested.at(), author: attested.author, sign: attested.sign, anchor: { chain: TEMPO, minter: C }, aliases: [toTempo], evm: PIN }), "STATE_MOVE_LAYER");
    const proven = await anchoredOn(ETHEREUM);
    const down = derivedTokenAlias(proven.id, { chain: ROBINHOOD, minter: C }, PIN);
    await rejects(updateOriginal(proven.anchoring, { versionTime: proven.at(), author: proven.author, sign: proven.sign, anchor: { chain: ROBINHOOD, minter: C }, aliases: [down], evm: PIN }), "STATE_MOVE_LAYER");
    const side = derivedTokenAlias(proven.id, { chain: BASE, minter: C }, PIN);
    await rejects(updateOriginal(proven.anchoring, { versionTime: proven.at(), author: proven.author, sign: proven.sign, anchor: { chain: BASE, minter: C }, aliases: [side], evm: PIN }), "STATE_MOVE_LAYER");
  });

  test("C12-267: entry that changes anchor without listing the destination's alias: rejected", async () => {
    const { anchoring, author, sign, at, token } = await anchoredOn(ROBINHOOD);
    await rejects(updateOriginal(anchoring, { versionTime: at(), author, sign, anchor: { chain: ETHEREUM, minter: C }, aliases: [], evm: PIN }), "STATE_MOVE_ALIAS");
    await rejects(updateOriginal(anchoring, { versionTime: at(), author, sign, anchor: null, aliases: [], evm: PIN }), "STATE_MOVE_ALIAS");
    // Keeping the old token alias is not listing the destination's: it is on another chain.
    await rejects(updateOriginal(anchoring, { versionTime: at(), author, sign, anchor: { chain: ETHEREUM, minter: C }, aliases: [token], evm: PIN }), "STATE_ALIASES");
  });

  test("C12-268: move entry to a chain the verifier's P14.22 does not list: unsupported, not invalid", async () => {
    const { anchoring, author, sign, at, id } = await anchoredOn(ROBINHOOD);
    const pin10: EvmAnchorPin = { ...PIN };
    const dest = `did:evm:10:${PIN.address}:${tokenIdOf(id, C)}`;
    // The writer refuses first (P9.19).
    await rejects(updateOriginal(anchoring, { versionTime: at(), author, sign, anchor: { chain: "eip155:10", minter: C }, aliases: [dest], evm: pin10 }), "EVM_CHAIN_NOT_LISTED", "unsupported-profile");
  });
});

describe("P9.26 no did:btco signers with an anchor member", () => {
  test("C12-262, C12-301: Original with an EVM anchor naming a did:btco author or editor: rejected", async () => {
    const { genesis, author, sign, at } = await anchoredOn(ROBINHOOD);
    await rejects(updateOriginal(genesis, { versionTime: at(), author, sign, editors: [{ did: "did:btco:reg:5", name: true, metadata: false, resource: false }], evm: PIN }), "STATE_ANCHOR_BTCO_SIGNER");
  });

  test("C12-262: 'Original with an EVM anchor naming a did:btco author': rejected by the writer, before signing, and by the state rules", async () => {
    const BTCO = "did:btco:reg:9000000000";
    const author = { did: BTCO, verificationMethod: `${BTCO}#orig`, versionId: `${"a".repeat(64)}i0` };
    let signed = false;
    const sign = async () => ((signed = true), []) as never;
    await rejects(createOriginal({ versionTime: clock()(), name: "x", resource: photo("x"), author, sign, anchor: { chain: ROBINHOOD, minter: A }, evm: PIN }), "STATE_ANCHOR_BTCO_SIGNER");
    expect(signed).toBe(false);
    // The verifier's state rule: a genesis entry carrying an anchor member and naming a did:btco author.
    const asset = { name: "x", status: "active", resource: photo("x"), aliases: [], anchor: { chain: ROBINHOOD, minter: A } };
    expect(() => checkEntryState({ id: "did:vh:s", operation: "create", author, asset, transitions: [{ from: null, to: photo("x").digest }] } as never, { scid: "s", index: 0, deactivatedParameter: false, evm: PIN }))
      .toThrow(expect.objectContaining({ code: "STATE_ANCHOR_BTCO_SIGNER" }));
    // Without an anchor member the same author is allowed (P5.13): the rule is P9.26's.
    expect(() => checkEntryState({ id: "did:vh:s", operation: "create", author, asset: { ...asset, anchor: undefined }, transitions: [{ from: null, to: photo("x").digest }] } as never, { scid: "s", index: 0, deactivatedParameter: false })).not.toThrow();
  });
});

describe("originals-spec PR 59: the remaining state rows", () => {
  test("C12-266: 'move entry in an Original anchored on Bitcoin': rejected (P9.28, P9.10, P9.19)", async () => {
    const key = seeded(36);
    const alice = await VhAuthor.create([{ fragment: "orig", signer: key }]);
    const at = clock();
    const sign = alice.signer(key, "orig");
    const author = alice.ref("orig");
    // Anchored on Bitcoin from the start: no anchor member, then the sat's did:btco alias.
    const genesis = await createOriginal({ versionTime: at(), name: "x", resource: photo("x"), author, sign });
    const onBitcoin = await updateOriginal(genesis, { versionTime: at(), author, sign, aliases: ["did:btco:reg:1234"] });
    const id = (genesis.state as { id: string }).id;
    const token = derivedTokenAlias(id, { chain: ETHEREUM, minter: C }, PIN);
    // A "move" to an EVM chain: it adds an anchor member, which no entry may (P9.19).
    await rejects(updateOriginal(onBitcoin, { versionTime: at(), author, sign, anchor: { chain: ETHEREUM, minter: C }, aliases: [token], evm: PIN }), "STATE_ANCHOR");
    // A "move" to another sat: the did:btco alias is terminal (P9.10).
    await rejects(updateOriginal(onBitcoin, { versionTime: at(), author, sign, aliases: ["did:btco:reg:5678"] }), "STATE_ANCHOR");
    // An Original that moved up to Bitcoin is anchored on Bitcoin: it does not move again (P9.28).
    const evm = await anchoredOn(ROBINHOOD);
    const arrived = await updateOriginal(evm.anchoring, { versionTime: evm.at(), author: evm.author, sign: evm.sign, anchor: null, aliases: ["did:btco:reg:99"], evm: PIN });
    const back = derivedTokenAlias(evm.id, { chain: ETHEREUM, minter: C }, PIN);
    await rejects(updateOriginal(arrived, { versionTime: evm.at(), author: evm.author, sign: evm.sign, anchor: { chain: ETHEREUM, minter: C }, aliases: [back], evm: PIN }), "STATE_ANCHOR");
    await rejects(updateOriginal(arrived, { versionTime: evm.at(), author: evm.author, sign: evm.sign, aliases: ["did:btco:reg:100"], evm: PIN }), "STATE_ANCHOR");
  });

  test("C12-267: 'Move entry signed by an editor': rejected, outside the grant (P9.28, P5.16)", async () => {
    const o = await anchoredOn(ROBINHOOD);
    const bobKey = seeded(37);
    const bob = await VhAuthor.create([{ fragment: "edit", signer: bobKey }]);
    const granted = await updateOriginal(o.anchoring, { versionTime: o.at(), author: o.author, sign: o.sign, editors: [{ did: bob.did, name: true, metadata: true, resource: true }], evm: PIN });
    const asBob = { editor: bob.ref("edit"), sign: bob.signer(bobKey, "edit") };
    const dest = derivedTokenAlias(o.id, { chain: ETHEREUM, minter: C }, PIN);
    // Even with every content right, an editor cannot write a move entry: not up a chain, nor to Bitcoin.
    // Keeping the token left behind also breaks the alias rule, which the asset check finds first.
    await rejects(updateOriginal(granted, { versionTime: o.at(), ...asBob, anchor: { chain: ETHEREUM, minter: C }, evm: PIN }), "STATE_ALIASES");
    await rejects(updateOriginal(granted, { versionTime: o.at(), ...asBob, anchor: null, evm: PIN }), "STATE_ALIASES");
    await rejects(updateOriginal(granted, { versionTime: o.at(), ...asBob, anchor: { chain: ETHEREUM, minter: C }, aliases: [dest], evm: PIN }), "EDITOR_AUTHOR_ONLY", "outside-grant");
    // An editor's change of `anchor` in a state that is otherwise valid (here before anchoring, with no
    // token alias yet) is outside every grant, as the engine's editor hook reports it (P5.16, P9.28).
    const early = await updateOriginal(o.genesis, { versionTime: o.at(), author: o.author, sign: o.sign, editors: [{ did: bob.did, name: true, metadata: true, resource: true }], evm: PIN });
    await rejects(updateOriginal(early, { versionTime: o.at(), ...asBob, anchor: { chain: ROBINHOOD, minter: C }, evm: PIN }), "EDITOR_AUTHOR_ONLY", "outside-grant");
    const earlyState = { ...(early.state as object), editor: bob.ref("edit"), asset: { ...(early.state as { asset: object }).asset, anchor: { chain: ROBINHOOD, minter: C } } };
    expect(() => checkEditorChange(earlyState as never, { scid: o.id.slice(7), index: 2, previous: early.state as never, deactivatedParameter: false, evm: PIN }))
      .toThrow(expect.objectContaining({ code: "EDITOR_AUTHOR_ONLY", category: "outside-grant" }));
    // The verifier's state rule on a complete move state an editor signed, with and without the editor rules first.
    const previous = granted.state as never;
    const scid = o.id.slice("did:vh:".length);
    const asset = { ...(granted.state as { asset: object }).asset, anchor: { chain: ETHEREUM, minter: C }, aliases: [dest] };
    const state = { id: o.id, operation: "update", author: o.author, editor: bob.ref("edit"), asset, transitions: [] };
    expect(() => checkEntryState(state as never, { scid, index: 3, previous, deactivatedParameter: false, evm: PIN, editorRules: false })).toThrow(expect.objectContaining({ code: "STATE_MOVE_BY_EDITOR", category: "outside-grant" }));
    expect(() => checkEntryState(state as never, { scid, index: 3, previous, deactivatedParameter: false, evm: PIN })).toThrow(expect.objectContaining({ category: "outside-grant" }));
    // The author's own move from the same parent is accepted.
    await updateOriginal(granted, { versionTime: o.at(), author: o.author, sign: o.sign, anchor: { chain: ETHEREUM, minter: C }, aliases: [dest], evm: PIN });
  });

  test("C12-282: 'aliases holding the token's CAIP-19 asset ID, or a did:evm DID with an uppercase address': rejected (P14.18)", async () => {
    const { genesis, author, sign, at, token } = await anchoredOn(ROBINHOOD);
    const caip19 = caip19Of(token);
    expect(caip19.startsWith("eip155:4663/erc721:")).toBe(true);
    for (const aliases of [[caip19], [token, caip19], [`did:${caip19}`]]) {
      await rejects(updateOriginal(genesis, { versionTime: at(), author, sign, aliases, evm: PIN }), "STATE_ALIASES");
    }
    // The token's own DID with its address in uppercase (or EIP-55 mixed case) is not P14.18's form.
    const [, , chainId, address, tokenId] = token.split(":");
    for (const bad of [`did:evm:${chainId}:0x${address.slice(2).toUpperCase()}:${tokenId}`, `did:evm:${chainId}:0x${address.slice(2, 4).toUpperCase()}${address.slice(4)}:${tokenId}`]) {
      await expect(updateOriginal(genesis, { versionTime: at(), author, sign, aliases: [bad], evm: PIN })).rejects.toMatchObject({ code: "STATE_ALIASES" });
    }
    const asset = { ...(genesis.state as { asset: object }).asset, aliases: [caip19] };
    const id = (genesis.state as { id: string }).id;
    expect(() => checkEntryState({ id, operation: "update", author, asset, transitions: [] } as never, { scid: id.slice(7), index: 1, previous: genesis.state as never, deactivatedParameter: false, evm: PIN }))
      .toThrow(expect.objectContaining({ code: "STATE_ALIASES" }));
  });

  test("C12-300: 'Grant naming the Original's token alias': rejected (P5.15)", async () => {
    const { anchoring, author, sign, at, token } = await anchoredOn(ROBINHOOD);
    await rejects(updateOriginal(anchoring, { versionTime: at(), author, sign, editors: [{ did: token, name: true, metadata: false, resource: false }], evm: PIN }), "STATE_EDITORS");
    // Nor before anchoring, while the token alias is not yet listed: it is still the Original's (P5.15).
    const { genesis, author: a2, sign: s2, at: at2, token: t2 } = await anchoredOn(TEMPO);
    await rejects(updateOriginal(genesis, { versionTime: at2(), author: a2, sign: s2, editors: [{ did: t2, name: true, metadata: false, resource: false }], evm: PIN }), "STATE_EDITORS");
  });
});
