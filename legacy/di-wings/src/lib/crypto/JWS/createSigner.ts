import type { JWA_ALG } from '../constants.js';
import { base64url } from '../utils/encoding.js';
import { Buffer } from 'buffer/index.js';

export type Signer = {
	sign: ({ data }: { data: Uint8Array }) => Promise<Uint8Array>;
};

export const detachedHeaderParams = {
	b64: false,
	crit: ['b64']
};

export const createJWSSigner = (
	signer: Signer,
	type: JWA_ALG,
	options: any = {
		detached: false
	}
) => {
	return {
		sign: async (
			data: Uint8Array,
			options?: { detached?: boolean; header?: object }
		): Promise<string> => {
			const header = {
				alg: type,
				...options?.header,
				...(options?.detached ? detachedHeaderParams : undefined)
			};
			const encodedHeader = base64url.encode(Buffer.from(JSON.stringify(header)));
			const encodedPayload = base64url.encode(
				data instanceof Uint8Array ? data : Buffer.from(JSON.stringify(data))
			);
			const toBeSigned = options?.detached
				? new Uint8Array(
						Buffer.concat([Buffer.from(encodedHeader, 'base64'), Buffer.from('.', 'utf-8'), data])
				  )
				: new Uint8Array(Buffer.from(`${encodedHeader}.${encodedPayload}`));

			const message = toBeSigned as any;
			const signature = await signer.sign({ data: message });

			return options?.detached
				? `${encodedHeader}..${base64url.encode(Buffer.from(signature))}`
				: `${encodedHeader}.${encodedPayload}.${base64url.encode(Buffer.from(signature))}`;
		}
	};
};
