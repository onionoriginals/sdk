export * from './common';
export * from './did';
export * from './credentials';
export * from './bitcoin';
export * from './network';
export * from './multisig';
// Note: proof.ts and resource-version.ts are NOT re-exported here to avoid
// duplicate export conflicts with cel/types.ts and resources/index.ts in the
// main SDK index. Import directly from './proof' or './resource-version'.


