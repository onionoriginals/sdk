import { hash } from '@stablelib/sha256';
import { Buffer } from 'buffer/index.js';

export const sha256Uint8Array = (val: Uint8Array): Buffer => {
	return Buffer.from(hash(Buffer.from(val)));
};

export function stringToUint8Array(data: any) {
	if (typeof data === 'string') {
		// convert data to Uint8Array
		return new Uint8Array(Buffer.from(data));
	}
	if (!(data instanceof Uint8Array)) {
		throw new TypeError('"data" be a string or Uint8Array.');
	}
	return data;
}

export const sha256 = (val: string): string => {
	return Buffer.from(hash(Buffer.from(val))).toString('hex');
};

export const sha256buffer = (val: string): Buffer => {
	return Buffer.from(hash(Buffer.from(val)));
};

export const sha256pow = (
	source: string,
	target: string,
	data: string,
	user: string = 'anon',
	nonce: number = 0,
	iterations: number = 1,
	budget: number = 1000000, // about 10s worst case
	positionalReferenceHash: string = ''
) => {
	console.log(
		`sha256 mining - s:${source} t:${target} d:${data} i:${iterations} n:${nonce} b:${budget} u:${user}`
	);
	let found = [];
	let rotation: string;
	let totalRotations = 0;
	const limit = budget + nonce; //Our max nonce based on the starting value and budget provided

	for (let i = nonce; i < limit && found.length !== iterations; i++) {
		rotation = sha256(source + sha256(data) + target + user + i);
		//Check that we have found a full result
		if (rotation.slice(0, target.length) === target && rotation > positionalReferenceHash) {
			const timestamp = Math.round(new Date().getTime() / 1000);
			console.log(`found slot ${rotation}`);
			const item = {
				data: data,
				datahash: sha256(data),
				n: i,
				rotation: rotation,
				source: source,
				target: target,
				timestamp: timestamp,
				user: user
			};
			//Return item
			found.push(item);
		}
		totalRotations++;
	}
	console.log(`finished mining after ${totalRotations} rotations`);
	return found;
};
