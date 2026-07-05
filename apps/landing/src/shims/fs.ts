// Browser shim for `fs`. The SDK only touches the filesystem when asked to
// persist DID logs to an outputDir — the landing demo never does. Any call
// reaching this shim is a bug, so fail loudly instead of silently no-op'ing.
const unavailable = (name: string) => () => {
  throw new Error(`fs.${name} is not available in the browser demo`);
};

export const writeFileSync = unavailable('writeFileSync');
export const readFileSync = unavailable('readFileSync');
export const mkdirSync = unavailable('mkdirSync');
export const existsSync = () => false;
export const promises = {
  writeFile: unavailable('promises.writeFile'),
  readFile: unavailable('promises.readFile'),
  mkdir: unavailable('promises.mkdir')
};
export default { writeFileSync, readFileSync, mkdirSync, existsSync, promises };
