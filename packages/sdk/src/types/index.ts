export * from './common.js';
export * from './did.js';
export * from './credentials.js';
export * from './bitcoin.js';
export * from './network.js';
export * from './multisig.js';
// Note: proof.ts and resource-version.ts are NOT re-exported here to avoid
// duplicate export conflicts with cel/types.ts and resources/index.ts in the
// main SDK index. Import directly from './proof.js' or './resource-version'.


