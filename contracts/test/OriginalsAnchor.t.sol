// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Base} from "./Base.sol";
import {OriginalsAnchor, IERC721Receiver} from "../src/OriginalsAnchor.sol";

/// A contract account that holds a token and publishes on it (P9.23).
contract Holder is IERC721Receiver {
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }

    function publish(OriginalsAnchor a, uint256 tokenId, bytes calldata m, bytes calldata b) external returns (uint32) {
        return a.publish(tokenId, "image/png", m, b);
    }
}

/// Tests cite originals-spec PR 59's section 12 rows by C12 id and the row's first column.
contract OriginalsAnchorTest is Base {
    OriginalsAnchor internal a;
    address internal constant ALICE = address(0xA11CE);
    address internal constant BOB = address(0xB0B);
    address internal constant CAROL = address(0xCA201);
    bytes32 internal constant ORIGINAL = keccak256("did:vh:QmExampleOriginal");
    uint256 internal constant LIMIT = 350_000;

    function setUp() public {
        a = new OriginalsAnchor();
    }

    function minted(address minter, bytes32 original) internal returns (uint256 id) {
        vm.prank(minter);
        id = a.mint(original);
    }

    function minted() internal returns (uint256) {
        return minted(ALICE, ORIGINAL);
    }

    // ----------------------------------------------------------------- P14.19 token ID

    /// The same fixed vector is asserted against `tokenIdOf` in packages/vh (computed with bun).
    function test_tokenIdMatchesVhTokenIdOf() public {
        bytes32 original = keccak256(bytes("did:vh:QmTokenIdVectorTokenIdVectorTokenIdVectorAb"));
        eq(uint256(original), 0xae30a9c9c4b44f659595fc6f456c47965e3a65f51758731abe96e9f821d2afcf, "keccak256(d)");
        address minter = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8;
        uint256 id = minted(minter, original);
        eq(id, 20858368355252256299581551563604764185791125045720593045312434452299842003849, "token ID");
        eq(id, 0x2e1d6b09f74f6881e988ff72ac0084a3c3bcd3aec5a113b1f027438a70ef2389, "token ID hex");
        eq(a.ownerOf(id), minter, "minted to the caller");
    }

    function test_mintDerivesFromCallerAndRevertsIfExists() public {
        uint256 id = minted();
        eq(id, uint256(keccak256(abi.encode(ORIGINAL, ALICE))), "P14.19");
        eq(a.balanceOf(ALICE), 1, "balance");
        vm.expectRevert(abi.encodeWithSelector(OriginalsAnchor.TokenExists.selector, id));
        vm.prank(ALICE);
        a.mint(ORIGINAL);
        // Another caller mints a different token for the same Original: not the Original's token.
        uint256 other = minted(BOB, ORIGINAL);
        truth(other != id, "different minter, different token");
    }

    // ----------------------------------------------------------------- publish in one transaction

    function test_publishStoresBytesAcrossChunksAndReadsRanges() public {
        uint256 id = minted();
        bytes memory m = blob(3_001, 1);
        bytes memory b = blob(60_000, 2); // three data contracts: 24,575 + 24,575 + 10,850
        vm.warp(1_800_000_000);
        vm.prank(ALICE);
        uint32 index = a.publish(id, "image/png", m, b);
        eq(index, 0, "index");
        eq(a.publicationCount(id), 1, "count");
        (uint64 ts, uint32 ml, uint32 bl, uint32 bodyOf, string memory mt) = a.publication(id, 0);
        eq(ts, 1_800_000_000, "block.timestamp");
        eq(ml, m.length, "metadataLength");
        eq(bl, b.length, "bodyLength");
        eq(bodyOf, 0, "stored its own body");
        eq(mt, "image/png", "mediaType");
        eq(a.metadata(id, 0, 0, type(uint32).max), m, "whole metadata");
        eq(a.body(id, 0, 0, type(uint32).max), b, "whole body");
        // Ranges straddling data-contract boundaries, ranges past the end, and an empty range.
        eq(a.body(id, 0, 24_000, 1_000), slice(b, 24_000, 25_000), "across a chunk boundary");
        eq(a.body(id, 0, 21_000, 30_000), slice(b, 21_000, 51_000), "over a whole chunk");
        eq(a.body(id, 0, 59_990, 100), slice(b, 59_990, 60_000), "fewer at the end");
        eq(a.body(id, 0, 60_000, 10).length, 0, "offset at the end");
        eq(a.body(id, 0, 70_000, 10).length, 0, "offset past the end");
        eq(a.metadata(id, 0, 3_000, 5), slice(m, 3_000, 3_001), "metadata end");
        eq(a.metadata(id, 0, 0, 0).length, 0, "empty range");
    }

    function test_readsOfMissingRecordRevert() public {
        uint256 id = minted();
        vm.expectRevert(abi.encodeWithSelector(OriginalsAnchor.NoSuchRecord.selector, id, 0));
        a.publication(id, 0);
        vm.expectRevert(abi.encodeWithSelector(OriginalsAnchor.NoSuchRecord.selector, id, 0));
        a.body(id, 0, 0, 1);
    }

    // ----------------------------------------------------------------- who may publish (P14.20, P9.23)

    /// C12-252: "Publication by an address that is neither the holder nor an approved operator":
    /// reverted by the contract; no record.
    function test_publicationByNonHolderReverts() public {
        uint256 id = minted();
        bytes memory m = hex"80";
        vm.startPrank(BOB);
        vm.expectRevert(abi.encodeWithSelector(OriginalsAnchor.NotHolderOrOperator.selector, id, BOB));
        a.publish(id, "image/png", m, hex"01");
        vm.expectRevert(abi.encodeWithSelector(OriginalsAnchor.NotHolderOrOperator.selector, id, BOB));
        a.begin(id);
        vm.stopPrank();
        eq(a.publicationCount(id), 0, "no record");

        // An operator approved for all, and one approved for the token, may publish.
        vm.prank(ALICE);
        a.setApprovalForAll(BOB, true);
        vm.prank(BOB);
        a.publish(id, "image/png", m, hex"01");
        vm.prank(ALICE);
        a.setApprovalForAll(BOB, false);
        vm.prank(ALICE);
        a.approve(CAROL, id);
        vm.prank(CAROL);
        a.publish(id, "image/png", m, hex"02");
        eq(a.publicationCount(id), 2, "two records");

        // After a transfer the old holder may not, and the token approval is cleared.
        vm.prank(ALICE);
        a.transferFrom(ALICE, BOB, id);
        vm.expectRevert(abi.encodeWithSelector(OriginalsAnchor.NotHolderOrOperator.selector, id, ALICE));
        vm.prank(ALICE);
        a.publish(id, "image/png", m, hex"03");
        vm.expectRevert(abi.encodeWithSelector(OriginalsAnchor.NotHolderOrOperator.selector, id, CAROL));
        vm.prank(CAROL);
        a.publish(id, "image/png", m, hex"03");
        vm.prank(BOB);
        a.publish(id, "image/png", m, hex"03");
    }

    function test_publishOnNonexistentTokenReverts() public {
        vm.expectRevert(abi.encodeWithSelector(OriginalsAnchor.NonexistentToken.selector, 7));
        a.publish(7, "image/png", hex"80", hex"");
    }

    /// The holder at `commit` is checked, not at `begin`: an upload opened before a transfer cannot
    /// be committed by the old holder (P14.20 "at that moment").
    function test_commitChecksHolderAtThatMoment() public {
        uint256 id = minted();
        vm.prank(ALICE);
        bytes32 up = a.begin(id);
        vm.prank(ALICE);
        a.append(up, hex"8001");
        vm.prank(ALICE);
        a.transferFrom(ALICE, BOB, id);
        vm.expectRevert(abi.encodeWithSelector(OriginalsAnchor.NotHolderOrOperator.selector, id, ALICE));
        vm.prank(ALICE);
        a.commit(up, "image/png", 1);
        eq(a.publicationCount(id), 0, "no record");
    }

    /// C12-264: "Token held by a contract account": that contract is the owner (P9.23).
    function test_contractAccountHolderPublishes() public {
        uint256 id = minted();
        Holder h = new Holder();
        vm.prank(ALICE);
        a.safeTransferFrom(ALICE, address(h), id);
        eq(a.ownerOf(id), address(h), "the contract is the owner");
        h.publish(a, id, hex"80", hex"0102");
        eq(a.publicationCount(id), 1, "the contract published");
        eq(a.body(id, 0, 0, 10), hex"0102", "body");
    }

    function test_safeTransferToNonReceiverReverts() public {
        uint256 id = minted();
        vm.expectRevert(abi.encodeWithSelector(OriginalsAnchor.UnsafeRecipient.selector, address(this)));
        vm.prank(ALICE);
        a.safeTransferFrom(ALICE, address(this), id);
    }

    // ----------------------------------------------------------------- limits (P9.25, P14.20)

    /// C12-254: "`publish` or `publishSameBody` whose bytes exceed 350,000, an `append` that would
    /// take an upload past 350,000 bytes, or a media type longer than 255 bytes": reverted by the
    /// contract; no record and no stored bytes.
    function test_limitsRevertWithNoRecordAndNoStoredBytes() public {
        uint256 id = minted();
        bytes memory m = blob(1_000, 3);
        bytes memory over = blob(LIMIT - 1_000 + 1, 4);
        uint64 nonce = vm.getNonce(address(a));
        vm.startPrank(ALICE);

        vm.expectRevert(abi.encodeWithSelector(OriginalsAnchor.TooLarge.selector, LIMIT + 1));
        a.publish(id, "image/png", m, over);

        bytes memory long = new bytes(256);
        vm.expectRevert(abi.encodeWithSelector(OriginalsAnchor.MediaTypeTooLong.selector, 256));
        a.publish(id, string(long), m, hex"01");
        eq(vm.getNonce(address(a)), nonce, "no data contract created by the reverted publishes");

        // A stored body to refer to, then a sameBody publication whose metadata exceeds the limit.
        a.publish(id, "image/png", m, hex"01");
        nonce = vm.getNonce(address(a));
        vm.expectRevert(abi.encodeWithSelector(OriginalsAnchor.TooLarge.selector, LIMIT + 1));
        a.publishSameBody(id, blob(LIMIT + 1, 5), 0);
        eq(vm.getNonce(address(a)), nonce, "no data contract created by the reverted publishSameBody");

        bytes32 up = a.begin(id);
        a.append(up, blob(LIMIT - 10, 6));
        uint64 afterAppend = vm.getNonce(address(a));
        vm.expectRevert(abi.encodeWithSelector(OriginalsAnchor.TooLarge.selector, LIMIT + 1));
        a.append(up, blob(11, 7));
        eq(vm.getNonce(address(a)), afterAppend, "no data contract created by the reverted append");
        a.append(up, blob(10, 7)); // exactly 350,000 is accepted

        vm.expectRevert(abi.encodeWithSelector(OriginalsAnchor.MediaTypeTooLong.selector, 256));
        a.commit(up, string(long), 100);
        vm.stopPrank();

        eq(a.publicationCount(id), 1, "only the one valid record");
    }

    function test_exactlyAtTheLimitsIsAccepted() public {
        uint256 id = minted();
        bytes memory m = blob(50_000, 8);
        bytes memory b = blob(LIMIT - 50_000, 9);
        string memory mt = string(blob(255, 10));
        vm.prank(ALICE);
        a.publish(id, mt, m, b);
        (, uint32 ml, uint32 bl,, string memory got) = a.publication(id, 0);
        eq(uint256(ml) + bl, LIMIT, "350,000 bytes");
        eq(got, mt, "255-byte media type");
        eq(a.body(id, 0, 0, type(uint32).max), b, "body");
        vm.prank(ALICE);
        a.publishSameBody(id, blob(LIMIT, 11), 0);
        eq(a.publicationCount(id), 2, "sameBody metadata at the limit");
    }

    // ----------------------------------------------------------------- staged upload (P14.20)

    /// C12-253: "Upload opened and never committed": ignored.
    function test_uploadNeverCommittedIsIgnored() public {
        uint256 id = minted();
        vm.startPrank(ALICE);
        bytes32 up = a.begin(id);
        a.append(up, blob(40_000, 12));
        vm.stopPrank();
        eq(a.publicationCount(id), 0, "no record");
        vm.expectRevert(abi.encodeWithSelector(OriginalsAnchor.NoSuchRecord.selector, id, 0));
        a.metadata(id, 0, 0, 1);
        // A later one-transaction publication is index 0; the open upload changes nothing.
        vm.prank(ALICE);
        eq(a.publish(id, "image/png", hex"80", hex"01"), 0, "index 0");
    }

    function test_uploadOnlyItsOpenerAppendsAndCommitsOnce() public {
        uint256 id = minted();
        vm.prank(ALICE);
        a.setApprovalForAll(BOB, true);
        vm.prank(ALICE);
        bytes32 up = a.begin(id);
        // Bob is an approved operator, but not the caller of `begin`.
        vm.expectRevert(abi.encodeWithSelector(OriginalsAnchor.NotUploader.selector, up, BOB));
        vm.prank(BOB);
        a.append(up, hex"01");
        vm.prank(ALICE);
        a.append(up, hex"800102");
        vm.expectRevert(abi.encodeWithSelector(OriginalsAnchor.NotUploader.selector, up, BOB));
        vm.prank(BOB);
        a.commit(up, "image/png", 1);
        vm.expectRevert(abi.encodeWithSelector(OriginalsAnchor.MetadataLengthExceedsUpload.selector, 4, 3));
        vm.prank(ALICE);
        a.commit(up, "image/png", 4);
        vm.prank(ALICE);
        eq(a.commit(up, "image/png", 1), 0, "committed");
        vm.expectRevert(abi.encodeWithSelector(OriginalsAnchor.UploadCommitted.selector, up));
        vm.prank(ALICE);
        a.commit(up, "image/png", 1);
        vm.expectRevert(abi.encodeWithSelector(OriginalsAnchor.UploadCommitted.selector, up));
        vm.prank(ALICE);
        a.append(up, hex"03");
        vm.expectRevert(abi.encodeWithSelector(OriginalsAnchor.UploadCommitted.selector, up));
        vm.prank(ALICE);
        a.commitSameBody(up, 0);
        eq(a.metadata(id, 0, 0, 100), hex"80", "metadata is the first metadataLength bytes");
        eq(a.body(id, 0, 0, 100), hex"0102", "body is the rest");
        bytes32 unknown = keccak256("no such upload");
        vm.expectRevert(abi.encodeWithSelector(OriginalsAnchor.NotUploader.selector, unknown, ALICE));
        vm.prank(ALICE);
        a.append(unknown, hex"01");
    }

    function test_stagedUploadMatchesOneTransaction() public {
        uint256 id = minted();
        bytes memory m = blob(2_500, 13);
        bytes memory b = blob(100_000, 14);
        bytes memory all = concat(m, b);
        vm.startPrank(ALICE);
        bytes32 up = a.begin(id);
        // Appends of uneven sizes, one splitting the metadata from the body mid-call.
        a.append(up, slice(all, 0, 1_000));
        a.append(up, slice(all, 1_000, 30_000));
        a.append(up, slice(all, 30_000, 60_001));
        a.append(up, slice(all, 60_001, all.length));
        uint32 index = a.commit(up, "image/webp", uint32(m.length));
        vm.stopPrank();
        (, uint32 ml, uint32 bl, uint32 bodyOf, string memory mt) = a.publication(id, index);
        eq(ml, m.length, "metadataLength");
        eq(bl, b.length, "bodyLength");
        eq(bodyOf, index, "stored its body");
        eq(mt, "image/webp", "mediaType");
        eq(a.metadata(id, index, 0, type(uint32).max), m, "metadata");
        eq(a.body(id, index, 0, type(uint32).max), b, "body");
        eq(a.body(id, index, 27_400, 3_000), slice(b, 27_400, 30_400), "body range across appends");
    }

    // ----------------------------------------------------------------- referring to a stored body

    /// C12-281: "Entry of 30,000 bytes that does not change the resource, on a chain that accepts
    /// 24,000 bytes in one transaction": uploaded in stages and recorded by `commitSameBody`,
    /// referring to the stored body.
    function test_largeEntryUploadedInStagesRefersToStoredBody() public {
        uint256 id = minted();
        bytes memory b = blob(20_000, 15);
        vm.startPrank(ALICE);
        a.publish(id, "image/png", blob(500, 16), b);
        bytes memory entry = blob(30_000, 17);
        bytes32 up = a.begin(id);
        a.append(up, slice(entry, 0, 24_000));
        a.append(up, slice(entry, 24_000, 30_000));
        uint32 index = a.commitSameBody(up, 0);
        vm.stopPrank();
        (, uint32 ml, uint32 bl, uint32 bodyOf, string memory mt) = a.publication(id, index);
        eq(index, 1, "index");
        eq(ml, 30_000, "metadata is the whole upload");
        eq(bl, 20_000, "bodyLength of the stored body");
        eq(bodyOf, 0, "refers to record 0");
        eq(mt, "image/png", "takes that record's media type");
        eq(a.metadata(id, 1, 0, type(uint32).max), entry, "metadata");
        eq(a.body(id, 1, 0, type(uint32).max), b, "body is record 0's");
        eq(a.body(id, 1, 100, 50), slice(b, 100, 150), "body range");
    }

    function test_publishSameBody() public {
        uint256 id = minted();
        bytes memory b = blob(30_000, 18);
        vm.startPrank(ALICE);
        a.publish(id, "image/png", hex"81", b);
        uint32 index = a.publishSameBody(id, hex"82", 0);
        vm.stopPrank();
        (, uint32 ml, uint32 bl, uint32 bodyOf, string memory mt) = a.publication(id, index);
        eq(ml, 1, "metadataLength");
        eq(bl, 30_000, "bodyLength");
        eq(bodyOf, 0, "bodyOf");
        eq(mt, "image/png", "media type");
        eq(a.metadata(id, index, 0, 10), hex"82", "own metadata");
        eq(a.body(id, index, 0, type(uint32).max), b, "record 0's body");
    }

    /// C12-260: "`publishSameBody` or `commitSameBody` naming a later record, a record of another
    /// token, or a record that itself refers to another": reverted by the contract; no record.
    function test_sameBodyMisuseReverts() public {
        uint256 id = minted();
        uint256 other = minted(BOB, ORIGINAL);
        vm.startPrank(BOB);
        a.publish(other, "image/png", hex"80", hex"01");
        a.publish(other, "image/png", hex"80", hex"02"); // the other token has records 0 and 1
        vm.stopPrank();

        vm.startPrank(ALICE);
        // Naming the next (later) record, on a token with no records.
        vm.expectRevert(abi.encodeWithSelector(OriginalsAnchor.NotStoredBody.selector, id, 0));
        a.publishSameBody(id, hex"80", 0);
        a.publish(id, "image/png", hex"80", hex"09");
        // Naming record 1, which exists only on the other token, and a later index.
        vm.expectRevert(abi.encodeWithSelector(OriginalsAnchor.NotStoredBody.selector, id, 1));
        a.publishSameBody(id, hex"80", 1);
        a.publishSameBody(id, hex"80", 0); // record 1 refers to record 0
        // Naming record 1, which itself refers to another.
        vm.expectRevert(abi.encodeWithSelector(OriginalsAnchor.NotStoredBody.selector, id, 1));
        a.publishSameBody(id, hex"80", 1);
        bytes32 up = a.begin(id);
        a.append(up, hex"80");
        vm.expectRevert(abi.encodeWithSelector(OriginalsAnchor.NotStoredBody.selector, id, 1));
        a.commitSameBody(up, 1);
        vm.expectRevert(abi.encodeWithSelector(OriginalsAnchor.NotStoredBody.selector, id, 2));
        a.commitSameBody(up, 2);
        vm.stopPrank();
        eq(a.publicationCount(id), 2, "no record from any misuse");
        eq(a.body(id, 1, 0, 10), hex"09", "record 1 has record 0's body, not the other token's");
    }

    // ----------------------------------------------------------------- tokenURI, ERC-165 (P14.21)

    function test_tokenURIFromOnChainStateOnly() public {
        uint256 id = minted();
        vm.prank(ALICE);
        a.publish(id, "image/png", hex"80", hex"01");
        eq(
            a.tokenURI(id),
            string.concat('data:application/json,{"name":"Original ', _dec(id), '","publications":1}'),
            "tokenURI"
        );
        truth(a.supportsInterface(0x80ac58cd) && a.supportsInterface(0x5b5e139f) && a.supportsInterface(0x01ffc9a7), "ERC-165");
        truth(!a.supportsInterface(0xffffffff), "not 0xffffffff");
    }

    function _dec(uint256 v) internal pure returns (string memory s) {
        if (v == 0) return "0";
        bytes memory b;
        for (; v != 0; v /= 10) b = bytes.concat(bytes1(uint8(48 + v % 10)), b);
        return string(b);
    }
}
