# Reading the authority decision

This is a worked example, not a Bitcoin test transcript. The letters name public
test keys and declared holder roles. Actual signed entries and exact expected
digests are in [histories.json](histories.json).

Start with an Original created under key A and anchored on its sat. Its accepted
history ends at **T**. Moving that sat changes possession, not its creator claims.

| What happens next | Accepted result |
| --- | --- |
| The sat is sold to a holder who has key H | T remains the head; A remains the signing controller. Live ownership changes. |
| H signs its own proposed update | Ignore the update: possession did not authorize H to make creator claims. |
| The holder publishes bytes already signed by current key A | Accept the valid extension. This is cooperation between the two required capabilities. |
| A signs a rotation to B, published in a later block | Accept **R**. B becomes current; A is retired. |
| A later gets the sat back and signs a new update | Keep R. Reacquisition does not restore A's authority. |
| B signs a valid update extending R | Accept **Bupdate** once it is published on the sat in a later block. |
| One publication carries A's rotation followed by B's update | Accept both together. The publication passes the height gate once; the controller changes between entries. |
| One publication carries A's rotation followed by another A-signed update | Reject that whole publication. Do not leave the rotation half-applied. |
| Two separate publications extend one another in the same block | Accept the first valid one; the second fails the strictly-later-height rule. |
| Two publications fork from the same old head | First valid publication in block/transaction/envelope order wins, regardless of API response order. |
| B deactivates the asset | Later creator changes stop. The sat can still be moved and the historical claims can still be checked. |
| A reorganization removes R | Rebuild from the surviving history. A is current again because R is absent from the accepted chain. |
| A provider cannot supply all inscriptions or their creation positions | Report incomplete evidence; do not pretend the last available prefix is current. |
| A provider lists a record for this sat but reports assignment to another sat | Report inconsistent evidence. This differs from readable bytes making an invalid signed claim. |
| Two valid boundary histories exist on the sat and a caller requests the later one's id | Select the earliest boundary first, then report the requested-id mismatch. A caller cannot choose a different asset for the same sat. |

Key retirement is evaluated against accepted history, not local proposals or
cached state. Old A signatures remain valid for their historical entries. A can
only become current again through a later valid rotation that explicitly
reauthorizes it, or because chain reconstruction removes the retiring rotation.

The [contract](../../../specs/originals-cel-v3-authority.md) defines the precise
rules. The [source research](../2026-09-05-cel-ordering-primary-sources.md) explains
the Bitcoin/ord observations needed to implement them. Real publications,
transfers, provider collection and reorganizations still need regtest evidence.
