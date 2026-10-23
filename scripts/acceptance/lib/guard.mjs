/**
 * In-process network guard, preloaded into every acceptance phase
 * (`node --import` or `bun --preload`). It is the second of two layers: the
 * orchestrator also runs each phase under an OS-level network denial where the
 * platform has one (macOS `sandbox-exec`, Linux `unshare -rn`). `probeNetwork`
 * in ./phase.mjs checks both layers and records the result in the receipt.
 */
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import * as nodeModule from "node:module";
import net from "node:net";
import tls from "node:tls";

class NetworkBlocked extends Error {
  constructor(what) {
    super(`network access is disabled in this acceptance phase (${what})`);
    this.name = "NetworkBlocked";
    this.code = "ACCEPTANCE_NETWORK_BLOCKED";
  }
}

const attempts = [];
const refuse = (what) => {
  return function blocked() {
    attempts.push(what);
    throw new NetworkBlocked(what);
  };
};

globalThis.fetch = async (input) => {
  attempts.push(`fetch ${String(input)}`);
  throw new NetworkBlocked("fetch");
};
for (const name of ["WebSocket", "EventSource", "XMLHttpRequest"]) {
  if (name in globalThis) {
    globalThis[name] = class {
      constructor() {
        attempts.push(name);
        throw new NetworkBlocked(name);
      }
    };
  }
}

net.Socket.prototype.connect = refuse("net.Socket#connect");
net.connect = refuse("net.connect");
net.createConnection = refuse("net.createConnection");
tls.connect = refuse("tls.connect");
for (const mod of [http, https]) {
  mod.request = refuse("http(s).request");
  mod.get = refuse("http(s).get");
}
for (const fn of ["lookup", "lookupService", "resolve", "resolve4", "resolve6", "resolveAny", "resolveCname", "resolveMx", "resolveNs", "resolveSrv", "resolveTxt", "reverse"]) {
  if (typeof dns[fn] === "function") dns[fn] = refuse(`dns.${fn}`);
  if (dns.promises && typeof dns.promises[fn] === "function") dns.promises[fn] = refuse(`dns.promises.${fn}`);
}
nodeModule.syncBuiltinESMExports?.();

globalThis.__acceptanceNetworkGuard = Object.freeze({ installed: true, attempts });
