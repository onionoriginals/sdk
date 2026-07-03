/**
 * Network-scoped did:btco identifier derivation, shared by state derivation
 * (BtcoCelManager) and the CLI display helpers so every btco identifier the
 * SDK emits agrees on the network prefix.
 *
 * Mainnet is bare (`did:btco:<sat>`); signet/regtest carry `sig`/`reg`
 * segments — mirroring DIDManager / createBtcoDidDocument.
 */
export function btcoDidPrefix(network: string | undefined): string {
  switch (network) {
    case 'signet':
      return 'did:btco:sig';
    case 'regtest':
      return 'did:btco:reg';
    case 'mainnet':
    case undefined:
      // undefined = legacy log with no recorded network; mainnet is the only
      // network the unprefixed did:btco form can mean.
      return 'did:btco';
    default:
      // An unrecognized network must not silently become a mainnet DID —
      // that would point the identifier at the wrong chain.
      throw new Error(`Unsupported Bitcoin network for did:btco: ${network}`);
  }
}

/**
 * Derives the resolvable did:btco identifier for a satoshi on a network.
 * The network should come from the SIGNED btco migration data
 * (`BtcoMigrationData.network`); legacy logs without it default to mainnet.
 */
export function btcoDidFromSatoshi(satoshi: string | number, network: string | undefined): string {
  return `${btcoDidPrefix(network)}:${satoshi}`;
}
