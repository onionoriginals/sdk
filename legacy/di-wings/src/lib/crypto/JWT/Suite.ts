import type { JWA_ALG } from "../constants";
import type { JWTPayload, VerificationResult } from "../../common/interfaces";
import type { JsonWebKey2020 } from "../keypairs/JsonWebKey2020";
import { base64url } from "../utils/encoding";

export class JWTSuite {
    public key: JsonWebKey2020;
    public alg: JWA_ALG;

    constructor(options: { key: JsonWebKey2020, alg: JWA_ALG }) {
        if (options.key) {
            this.key = options.key;
        } else {
            throw new Error('`key` is required');
        }
        if (options.alg) {
            this.alg = options.alg;
        } else {
            throw new Error('`alg` is required');
        }
    }

    async sign(payload: JWTPayload): Promise<string> {
        try {
            const { privateKeyJwk, id } = await this.key.export!({ privateKey: true });
            if (!privateKeyJwk) {
                throw new Error(`Private key not found`);
            }

            const header = {
                alg: this.alg,
                typ: "JWT",
                kid: id
            };

            const encodedHeader = base64url.encode(JSON.stringify(header));
            const encodedPayload = base64url.encode(JSON.stringify(payload));
            const signingInput = `${encodedHeader}.${encodedPayload}`;

            const keyPair = await this.key.exportAsLD!({ privateKey: true });
            const signature = await keyPair.sign!(Buffer.from(signingInput));

            return `${signingInput}.${base64url.encode(Buffer.from(signature))}`;
        } catch (e) {
            console.error('Failed to sign.', e);
            throw e;
        }
    }

    async verify(jwt: string): Promise<VerificationResult> {
        try {
            const [encodedHeader, encodedPayload, encodedSignature] = jwt.split('.');
            
            if (!encodedHeader || !encodedPayload || !encodedSignature) {
                throw new Error('Invalid JWT format');
            }

            const header = JSON.parse(Buffer.from(base64url.decode(encodedHeader)).toString());
            
            if (header.alg !== this.alg) {
                throw new Error(`Algorithm mismatch: expected ${this.alg}, got ${header.alg}`);
            }

            const signingInput = `${encodedHeader}.${encodedPayload}`;
            const signature = Buffer.from(base64url.decode(encodedSignature));

            const { publicKeyJwk } = await this.key.export!({ privateKey: false });
            if (!publicKeyJwk) {
                throw new Error(`Public key not found`);
            }

            const keyPair = await this.key.exportAsLD!({ privateKey: false });
            const isValid = await keyPair.verify!(Buffer.from(signingInput), signature);

            if (!isValid) {
                throw new Error('Invalid signature');
            }

            return {
                verified: true,
                errors: []
            };
        } catch (e: any) {
            console.error(e.message);
            return { verified: false, errors: [e.message] };
        }
    }
}