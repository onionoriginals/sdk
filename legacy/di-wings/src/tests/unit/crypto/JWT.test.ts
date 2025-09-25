import { beforeEach, describe, expect, test } from 'bun:test'
import { JWTSuite } from '../../../lib/crypto/JWT/Suite';
import { JsonWebKeyPair } from '../../../lib/crypto';

let jwk2020: any;

describe('JWT', () => {
    beforeEach(() => {
		jwk2020 = require('../../fixtures/keypairs/JsonWebKey2020.json');
	})
    test('createJWT will create a JWT', async () => {
        const key = await JsonWebKeyPair.fromJWK(jwk2020)
        const suite = new JWTSuite({key, alg: 'ES256K'})
        const signed = await suite.sign({claim: 'yes'})
        expect(signed.split('.').length).toBe(3)
    })

    test('verifyJWT will verify a JWT', async () => {
        const key = await JsonWebKeyPair.fromJWK(jwk2020)
        const suite = new JWTSuite({key, alg: 'ES256K'})
        debugger;
        const verified = await suite.verify('eyJhbGciOiJFUzI1NksiLCJ0eXAiOiJKV1QiLCJraWQiOiJkaWQ6ZXhhbXBsZToxMjMja2V5LTEifQ.eyJjbGFpbSI6InllcyJ9.3Z6A07kFWRwadAe0pmH-uX2lOT0K6QRlT0OljtubWfIS3SKyjl52QnqzvEg2pHHF6mO0USl2dCKvtmYxPj6NGA')
        expect(verified.verified).toBeTruthy()
        expect(verified.errors).toHaveLength(0)
    })

    test('verifyJWT will error on malformed JWT', async () => {
        const key = await JsonWebKeyPair.fromJWK(jwk2020)
        const suite = new JWTSuite({key, alg: 'ES256K'})
        const verified = await suite.verify('a51eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ0ZXN0Ijoib2siLCJpYXQiOjE2NTc3NTIzMDB9._E8d8OA7OPxQcEigW-neaF2lVju9OpjqryiVL8OZA7I')
        expect(verified.errors?.[0].length).toBeGreaterThan(1)
        expect(verified.verified).toBeFalsy()
    })
})