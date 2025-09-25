import { Secret } from "./Secret.js";
import { base64url, utf8, type Readable } from "../crypto";

export class JSONSecretResolver {
  private secrets: Secret[];

  constructor(json: object) {
    this.secrets = Array.isArray(json) ? json.map(j => new Secret(j)) : [new Secret(json)];
  }

  async resolve(id: string): Promise<Secret> {
    const secret = this.secrets.find(s => s.id === id)
    if (!secret) throw new Error(`Secret ${id} not found in provided secrets json`)
    return new Secret(secret);
  }
}

export class EnvironmentVariableSecretResolver {
  private secrets: Secret[];

  constructor(env: any) {
    if (!env.SECRETS) throw new Error('No (base64 encoded) SECRETS found in environment')
    this.secrets = JSON.parse(utf8.decode(base64url.decode(env.SECRETS)))
  }

  async resolve(id: string): Promise<Secret> {
    const secret = this.secrets.find(s => s.id === id)
    if (!secret) throw new Error(`Secret ${id} not found in SECRETS from environment`)
    return new Secret(secret);
  }
}

export class WalletSecretResolver {
  private secrets: Secret[] = [];

  constructor(store: Readable<any>) {
    var self = this;
    store.subscribe(r => {
      self.secrets = r
    })
  }

  async resolve(id: string): Promise<Secret> {
    try {
      const secret = this.secrets.find((s: any) => s.id === id)
      if (!secret) throw new Error(`Secret ${id} not found in store secrets`)
      return new Secret(secret);
    } catch (e: any) {
      console.error(e)
      throw new Error(e.message)
    }
  }
}