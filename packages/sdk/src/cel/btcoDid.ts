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
    default:
      return 'did:btco';
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
