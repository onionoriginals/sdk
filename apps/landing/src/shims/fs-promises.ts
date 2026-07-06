// Browser shim for `fs/promises` (only imported by the SDK's
// LocalStorageAdapter, which the demo replaces with MemoryStorageAdapter).
const unavailable = (name: string) => () => {
  throw new Error(`fs/promises.${name} is not available in the browser demo`);
};

export const readFile = unavailable('readFile');
export const writeFile = unavailable('writeFile');
export const mkdir = unavailable('mkdir');
export const readdir = unavailable('readdir');
export const rm = unavailable('rm');
export const stat = unavailable('stat');
export const unlink = unavailable('unlink');
export const access = unavailable('access');
export default { readFile, writeFile, mkdir, readdir, rm, stat, unlink, access };
