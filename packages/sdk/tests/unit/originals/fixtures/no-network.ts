/** Preload for the fresh-process test: any network use throws. */
import net from "node:net";
import dns from "node:dns";

const refuse = () => {
  throw new Error("network access is disabled in this process");
};
globalThis.fetch = refuse as unknown as typeof fetch;
net.Socket.prototype.connect = refuse as never;
net.connect = refuse as never;
net.createConnection = refuse as never;
dns.lookup = refuse as never;
dns.promises.lookup = refuse as never;
