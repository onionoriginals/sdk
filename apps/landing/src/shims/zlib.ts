// Browser shim for `node:zlib`. Only the credential status-list code paths
// use gzip, and the landing demo does not exercise them.
const unavailable = (name: string) => () => {
  throw new Error(`zlib.${name} is not available in the browser demo`);
};

export const gzipSync = unavailable('gzipSync');
export const gunzipSync = unavailable('gunzipSync');
export const inflateSync = unavailable('inflateSync');
export default { gzipSync, gunzipSync, inflateSync };
