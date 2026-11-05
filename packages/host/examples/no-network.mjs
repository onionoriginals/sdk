/**
 * Preload for the walkthrough's reader process (docs/CUSTODY_WALKTHROUGH.md,
 * step 5): any attempt to reach the network throws, so a reader that loads an
 * evidence package under it shows it needs none (P7.3).
 *
 *   node --import ./no-network.mjs <script>
 */
import net from "node:net";
import tls from "node:tls";
import dns from "node:dns";

const refuse = (what) => () => {
  throw new Error(`network disabled in this process (${what})`);
};
globalThis.fetch = refuse("fetch");
net.Socket.prototype.connect = refuse("net.Socket.connect");
net.connect = net.createConnection = refuse("net.connect");
tls.connect = refuse("tls.connect");
dns.lookup = refuse("dns.lookup");
dns.promises.lookup = refuse("dns.promises.lookup");
