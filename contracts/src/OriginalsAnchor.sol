// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

/// @title OriginalsAnchor (EXPERIMENTAL)
/// @notice The anchor contract of originals-spec PR 59 (3ed0f89), P14.19-P14.21: an ERC-721 whose
/// token for an Original is derived from the Original and its minter, and which keeps, per token,
/// an append-only list of publication records whose metadata and body bytes live in contract state
/// (P9.25), as the code of contracts it creates.
///
/// NOT REVIEWED, NOT AUDITED, AND NOT THE P14.21 PIN. P14.21 pins no contract yet; an Original
/// anchored on this deployment is supported only by an experiment that supplies its own pin.
///
/// No owner, administrator, proxy, upgrade, pause or self-destruct path (P14.21). The contract
/// judges no signature and no entry: it checks only who may publish (P9.12, P9.23).
contract OriginalsAnchor {
    // ------------------------------------------------------------------ events

    /// ERC-721 [S33].
    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);

    /// P14.20: helps a reader find records; never evidence (P9.25).
    event Published(uint256 indexed tokenId, uint32 index);

    /// PROVISIONAL extension, not in P14.20: `begin` returns the upload ID, but a transaction's
    /// return value is not observable off chain, so a writer learns it from this event. Never
    /// evidence of anything (P9.25).
    event UploadBegun(bytes32 indexed upload, uint256 indexed tokenId, address indexed opener);

    // ------------------------------------------------------------------ errors

    error TokenExists(uint256 tokenId);
    error NonexistentToken(uint256 tokenId);
    error NotHolderOrOperator(uint256 tokenId, address caller);
    error NotUploader(bytes32 upload, address caller);
    error UploadCommitted(bytes32 upload);
    error TooLarge(uint256 length);
    error MediaTypeTooLong(uint256 length);
    error MetadataLengthExceedsUpload(uint32 metadataLength, uint32 uploadLength);
    error NotStoredBody(uint256 tokenId, uint32 bodyOf);
    error NoSuchRecord(uint256 tokenId, uint32 index);
    error TooManyRecords(uint256 tokenId);
    error ChunkCreationFailed();
    error InvalidTransfer();
    error UnsafeRecipient(address to);

    // ------------------------------------------------------------------ limits (P9.25, P14.20)

    /// P9.17, P9.25: metadata and body a publication stores, and any upload, at most 350,000 bytes.
    uint256 public constant MAX_PUBLICATION_BYTES = 350_000;
    /// P14.20: a media type is at most 255 bytes.
    uint256 public constant MAX_MEDIA_TYPE_BYTES = 255;
    /// P14.20 [S37]: each data contract is a zero byte and at most 24,575 bytes (EIP-170: 24,576).
    uint256 private constant CHUNK_BYTES = 24_575;

    // ------------------------------------------------------------------ ERC-721 state

    mapping(uint256 => address) private _owners;
    mapping(address => uint256) private _balances;
    mapping(uint256 => address) private _tokenApprovals;
    mapping(address => mapping(address => bool)) private _operatorApprovals;

    // ------------------------------------------------------------------ publication state (P14.20)

    /// One slot per record. A record is never changed or removed. It holds no block number (P14.20).
    struct Record {
        uint64 timestamp;
        uint32 metadataLength;
        uint32 bodyLength;
        uint32 bodyOf;
    }

    struct Upload {
        uint256 tokenId;
        address opener;
        uint32 length;
        bool committed;
    }

    mapping(uint256 => Record[]) private _records;
    /// The media type of each record that stored its body; a record that refers to a body takes
    /// that record's (P14.20).
    mapping(uint256 => mapping(uint32 => string)) private _mediaTypes;
    /// The data contracts of a byte sequence, in order: the metadata, then (for a record that stored
    /// its body) the body. Keyed by `_key(tokenId, index)` for a one-transaction publication and by
    /// the upload ID for an upload.
    mapping(bytes32 => address[]) private _data;
    /// The upload a staged record was committed from (zero for a one-transaction publication).
    mapping(uint256 => mapping(uint32 => bytes32)) private _committedUpload;
    mapping(bytes32 => Upload) private _uploads;
    uint256 private _uploadNonce;

    // ------------------------------------------------------------------ mint (P14.19)

    /// P14.19: mints `uint256(keccak256(abi.encode(original, msg.sender)))` to the caller, where
    /// `original` is keccak256 of the Original's did:vh. Reverts if that token exists.
    function mint(bytes32 original) external returns (uint256 tokenId) {
        tokenId = uint256(keccak256(abi.encode(original, msg.sender)));
        if (_owners[tokenId] != address(0)) revert TokenExists(tokenId);
        unchecked {
            _balances[msg.sender] += 1;
        }
        _owners[tokenId] = msg.sender;
        emit Transfer(address(0), msg.sender, tokenId);
    }

    // ------------------------------------------------------------------ publish (P14.20)

    /// In one transaction: stores the metadata and body and adds a record. (Parameters are named
    /// `metadata` and `body` in P14.20; renamed here only so they do not shadow the read functions.
    /// Names are not part of the ABI.)
    function publish(uint256 tokenId, string calldata mediaType, bytes calldata metadataBytes, bytes calldata bodyBytes)
        external
        returns (uint32 index)
    {
        _requirePublisher(tokenId);
        if (bytes(mediaType).length > MAX_MEDIA_TYPE_BYTES) revert MediaTypeTooLong(bytes(mediaType).length);
        uint256 total = metadataBytes.length + bodyBytes.length;
        if (total > MAX_PUBLICATION_BYTES) revert TooLarge(total);
        index = _nextIndex(tokenId);
        address[] storage chunks = _data[_key(tokenId, index)];
        _store(chunks, metadataBytes);
        _store(chunks, bodyBytes);
        _mediaTypes[tokenId][index] = mediaType;
        _records[tokenId].push(Record(uint64(block.timestamp), uint32(metadataBytes.length), uint32(bodyBytes.length), index));
        emit Published(tokenId, index);
    }

    /// Referring to a stored body: stores the metadata and adds a record whose body is record
    /// `bodyOf`'s, which must be an earlier record of the same token that stored its own body.
    function publishSameBody(uint256 tokenId, bytes calldata metadataBytes, uint32 bodyOf) external returns (uint32 index) {
        _requirePublisher(tokenId);
        if (metadataBytes.length > MAX_PUBLICATION_BYTES) revert TooLarge(metadataBytes.length);
        Record storage ref = _storedBody(tokenId, bodyOf);
        uint32 bodyLength = ref.bodyLength;
        index = _nextIndex(tokenId);
        _store(_data[_key(tokenId, index)], metadataBytes);
        _records[tokenId].push(Record(uint64(block.timestamp), uint32(metadataBytes.length), bodyLength, bodyOf));
        emit Published(tokenId, index);
    }

    // ------------------------------------------------------------------ staged upload (P14.20)

    /// Opens an upload on `tokenId`. Only its caller can append to it or commit it.
    function begin(uint256 tokenId) external returns (bytes32 upload) {
        _requirePublisher(tokenId);
        unchecked {
            upload = keccak256(abi.encode(tokenId, msg.sender, ++_uploadNonce));
        }
        _uploads[upload] = Upload(tokenId, msg.sender, 0, false);
        emit UploadBegun(upload, tokenId, msg.sender);
    }

    /// Stores the next bytes of the upload. Reverts if they would take it past 350,000 bytes.
    /// Only the caller of `begin` may append; holding the token is checked at `commit` (P14.20).
    function append(bytes32 upload, bytes calldata data) external {
        Upload storage u = _openUpload(upload);
        uint256 total = uint256(u.length) + data.length;
        if (total > MAX_PUBLICATION_BYTES) revert TooLarge(total);
        u.length = uint32(total);
        _store(_data[upload], data);
    }

    /// Closes the upload and adds a record: its first `metadataLength` bytes are the metadata and
    /// the rest the body.
    function commit(bytes32 upload, string calldata mediaType, uint32 metadataLength) external returns (uint32 index) {
        Upload storage u = _openUpload(upload);
        uint256 tokenId = u.tokenId;
        _requirePublisher(tokenId);
        if (bytes(mediaType).length > MAX_MEDIA_TYPE_BYTES) revert MediaTypeTooLong(bytes(mediaType).length);
        uint32 length = u.length;
        if (metadataLength > length) revert MetadataLengthExceedsUpload(metadataLength, length);
        u.committed = true;
        index = _nextIndex(tokenId);
        _committedUpload[tokenId][index] = upload;
        _mediaTypes[tokenId][index] = mediaType;
        _records[tokenId].push(Record(uint64(block.timestamp), metadataLength, length - metadataLength, index));
        emit Published(tokenId, index);
    }

    /// Closes the upload and adds a record whose metadata is the whole upload and whose body is
    /// record `bodyOf`'s, on the conditions of `publishSameBody`.
    function commitSameBody(bytes32 upload, uint32 bodyOf) external returns (uint32 index) {
        Upload storage u = _openUpload(upload);
        uint256 tokenId = u.tokenId;
        _requirePublisher(tokenId);
        Record storage ref = _storedBody(tokenId, bodyOf);
        uint32 bodyLength = ref.bodyLength;
        u.committed = true;
        index = _nextIndex(tokenId);
        _committedUpload[tokenId][index] = upload;
        _records[tokenId].push(Record(uint64(block.timestamp), u.length, bodyLength, bodyOf));
        emit Published(tokenId, index);
    }

    // ------------------------------------------------------------------ reads (P14.20)

    function publicationCount(uint256 tokenId) external view returns (uint32) {
        return uint32(_records[tokenId].length);
    }

    function publication(uint256 tokenId, uint32 index)
        external
        view
        returns (uint64 timestamp, uint32 metadataLength, uint32 bodyLength, uint32 bodyOf, string memory mediaType)
    {
        Record storage r = _record(tokenId, index);
        return (r.timestamp, r.metadataLength, r.bodyLength, r.bodyOf, _mediaTypes[tokenId][r.bodyOf]);
    }

    /// The record's metadata from `offset`, at most `length` bytes, fewer at the end.
    function metadata(uint256 tokenId, uint32 index, uint32 offset, uint32 length) external view returns (bytes memory) {
        Record storage r = _record(tokenId, index);
        (uint256 from, uint256 to) = _range(0, r.metadataLength, offset, length);
        return _read(_data[_dataKey(tokenId, index)], from, to);
    }

    /// The record's body from `offset`, at most `length` bytes, fewer at the end; for a record that
    /// refers to an earlier one, that one's bytes.
    function body(uint256 tokenId, uint32 index, uint32 offset, uint32 length) external view returns (bytes memory) {
        uint32 owner = _record(tokenId, index).bodyOf;
        Record storage r = _records[tokenId][owner];
        (uint256 from, uint256 to) = _range(r.metadataLength, r.bodyLength, offset, length);
        return _read(_data[_dataKey(tokenId, owner)], from, to);
    }

    // ------------------------------------------------------------------ ERC-721 [S33]

    function name() external pure returns (string memory) {
        return "Originals Anchor (experimental)";
    }

    function symbol() external pure returns (string memory) {
        return "ORIGINAL";
    }

    /// P14.21: computed from the contract's own state; names no location off the chain. Its form is
    /// open (D6). It is never the did:evm DID document (P3.9).
    function tokenURI(uint256 tokenId) external view returns (string memory) {
        if (_owners[tokenId] == address(0)) revert NonexistentToken(tokenId);
        return string.concat(
            'data:application/json,{"name":"Original ',
            _toString(tokenId),
            '","publications":',
            _toString(_records[tokenId].length),
            "}"
        );
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x01ffc9a7 // ERC-165
            || interfaceId == 0x80ac58cd // ERC-721
            || interfaceId == 0x5b5e139f; // ERC-721 Metadata
    }

    function balanceOf(address owner) external view returns (uint256) {
        if (owner == address(0)) revert InvalidTransfer();
        return _balances[owner];
    }

    function ownerOf(uint256 tokenId) public view returns (address owner) {
        owner = _owners[tokenId];
        if (owner == address(0)) revert NonexistentToken(tokenId);
    }

    function approve(address to, uint256 tokenId) external {
        address owner = ownerOf(tokenId);
        if (msg.sender != owner && !_operatorApprovals[owner][msg.sender]) revert NotHolderOrOperator(tokenId, msg.sender);
        _tokenApprovals[tokenId] = to;
        emit Approval(owner, to, tokenId);
    }

    function getApproved(uint256 tokenId) external view returns (address) {
        ownerOf(tokenId);
        return _tokenApprovals[tokenId];
    }

    function setApprovalForAll(address operator, bool approved) external {
        _operatorApprovals[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function isApprovedForAll(address owner, address operator) external view returns (bool) {
        return _operatorApprovals[owner][operator];
    }

    function transferFrom(address from, address to, uint256 tokenId) public {
        address owner = ownerOf(tokenId);
        if (from != owner || to == address(0)) revert InvalidTransfer();
        if (!_authorized(owner, tokenId, msg.sender)) revert NotHolderOrOperator(tokenId, msg.sender);
        delete _tokenApprovals[tokenId];
        unchecked {
            _balances[from] -= 1;
            _balances[to] += 1;
        }
        _owners[tokenId] = to;
        emit Transfer(from, to, tokenId);
    }

    function safeTransferFrom(address from, address to, uint256 tokenId) external {
        safeTransferFrom(from, to, tokenId, "");
    }

    function safeTransferFrom(address from, address to, uint256 tokenId, bytes memory data) public {
        transferFrom(from, to, tokenId);
        if (to.code.length != 0) {
            try IERC721Receiver(to).onERC721Received(msg.sender, from, tokenId, data) returns (bytes4 ret) {
                if (ret != IERC721Receiver.onERC721Received.selector) revert UnsafeRecipient(to);
            } catch {
                revert UnsafeRecipient(to);
            }
        }
    }

    // ------------------------------------------------------------------ internals

    function _authorized(address owner, uint256 tokenId, address caller) private view returns (bool) {
        return caller == owner || _operatorApprovals[owner][caller] || _tokenApprovals[tokenId] == caller;
    }

    /// P14.20, P9.23: the token's holder, or an operator approved for it at this moment (ERC-721
    /// `setApprovalForAll`, or `approve` for this token: PROVISIONAL reading of "an operator approved
    /// for it").
    function _requirePublisher(uint256 tokenId) private view {
        address owner = _owners[tokenId];
        if (owner == address(0)) revert NonexistentToken(tokenId);
        if (!_authorized(owner, tokenId, msg.sender)) revert NotHolderOrOperator(tokenId, msg.sender);
    }

    function _openUpload(bytes32 upload) private view returns (Upload storage u) {
        u = _uploads[upload];
        // A nonexistent upload has opener 0, which is never msg.sender.
        if (u.opener != msg.sender) revert NotUploader(upload, msg.sender);
        if (u.committed) revert UploadCommitted(upload);
    }

    /// P14.20: `bodyOf` must be an earlier record of the same token that stored its own body.
    /// Indexes are per token, so a record of another token cannot be named.
    function _storedBody(uint256 tokenId, uint32 bodyOf) private view returns (Record storage r) {
        Record[] storage records = _records[tokenId];
        if (bodyOf >= records.length) revert NotStoredBody(tokenId, bodyOf);
        r = records[bodyOf];
        if (r.bodyOf != bodyOf) revert NotStoredBody(tokenId, bodyOf);
    }

    function _nextIndex(uint256 tokenId) private view returns (uint32) {
        uint256 n = _records[tokenId].length;
        if (n >= type(uint32).max) revert TooManyRecords(tokenId);
        return uint32(n);
    }

    function _record(uint256 tokenId, uint32 index) private view returns (Record storage) {
        Record[] storage records = _records[tokenId];
        if (index >= records.length) revert NoSuchRecord(tokenId, index);
        return records[index];
    }

    function _key(uint256 tokenId, uint32 index) private pure returns (bytes32) {
        return keccak256(abi.encode(tokenId, index));
    }

    function _dataKey(uint256 tokenId, uint32 index) private view returns (bytes32) {
        bytes32 upload = _committedUpload[tokenId][index];
        return upload == bytes32(0) ? _key(tokenId, index) : upload;
    }

    /// Absolute [from, to) within a byte sequence for the part starting at `base` of `size` bytes.
    function _range(uint256 base, uint256 size, uint32 offset, uint32 length) private pure returns (uint256, uint256) {
        if (offset >= size) return (base, base);
        uint256 end = uint256(offset) + length;
        if (end > size) end = size;
        return (base + offset, base + end);
    }

    /// SSTORE2-style: each chunk becomes the code of a new contract, a zero byte (STOP, so it cannot
    /// be called into anything) followed by at most 24,575 bytes (P14.20, EIP-170).
    function _store(address[] storage chunks, bytes calldata data) private {
        uint256 len = data.length;
        for (uint256 off; off < len; off += CHUNK_BYTES) {
            uint256 n = len - off;
            if (n > CHUNK_BYTES) n = CHUNK_BYTES;
            address a;
            assembly ("memory-safe") {
                let p := mload(0x40)
                // Init code: PUSH4 (n+1) DUP1 PUSH1 0x0e PUSH1 0 CODECOPY PUSH1 0 RETURN, then the runtime
                // code 0x00 ++ chunk. 14 header bytes; the runtime's zero byte is byte 14 of this word.
                mstore(p, or(shl(248, 0x63), or(shl(216, add(n, 1)), shl(144, 0x80600e6000396000f3))))
                calldatacopy(add(p, 15), add(data.offset, off), n)
                a := create(0, p, add(n, 15))
            }
            if (a == address(0)) revert ChunkCreationFailed();
            chunks.push(a);
        }
    }

    /// Bytes [from, to) of the concatenation of `chunks`' data.
    function _read(address[] storage chunks, uint256 from, uint256 to) private view returns (bytes memory out) {
        out = new bytes(to - from);
        if (to == from) return out;
        uint256 pos;
        uint256 written;
        uint256 n = chunks.length;
        for (uint256 i; i < n && pos < to; ++i) {
            address c = chunks[i];
            uint256 size;
            assembly {
                size := sub(extcodesize(c), 1)
            }
            uint256 end = pos + size;
            if (end > from) {
                uint256 s = from > pos ? from - pos : 0;
                uint256 e = to < end ? to - pos : size;
                assembly ("memory-safe") {
                    extcodecopy(c, add(add(out, 32), written), add(s, 1), sub(e, s))
                }
                written += e - s;
            }
            pos = end;
        }
    }

    function _toString(uint256 value) private pure returns (string memory) {
        if (value == 0) return "0";
        uint256 digits;
        for (uint256 v = value; v != 0; v /= 10) ++digits;
        bytes memory b = new bytes(digits);
        for (; value != 0; value /= 10) b[--digits] = bytes1(uint8(48 + value % 10));
        return string(b);
    }
}

interface IERC721Receiver {
    function onERC721Received(address operator, address from, uint256 tokenId, bytes calldata data)
        external
        returns (bytes4);
}
