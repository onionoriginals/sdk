# DI-Wings: Aviary Tech DI Library

The "DI" in DI-Wings represents multiple core concepts central to Aviary Tech's mission:

1. **D**ecentralized **I**dentity: Our primary focus is on revolutionizing identity management through decentralized systems, giving individuals control over their digital identities.

2. **D**ata **I**ntegrity: We ensure the authenticity and immutability of identity data, protecting it from unauthorized alterations and maintaining its trustworthiness.

3. **D**igital **I**nnovation: We're committed to pushing the boundaries of digital technology, constantly innovating in the realm of identity solutions and related fields.

"Wings" aligns with Aviary Tech's branding and symbolizes:

- Enabling technology that gives "flight" to our products

- Freedom and empowerment in digital identity management

This name encapsulates our commitment to decentralized, secure, and innovative digital identity solutions that empower users and organizations alike.

## Using di-wings Crypto

The di-wings library provides a robust set of cryptographic utilities for decentralized identity operations. Here's how to use some of the key features:

### Installation

```bash
npm install di-wings
```

### Key Generation

```typescript
import { Ed25519VerificationKey2020, Secp256k1KeyPair } from 'di-wings';

// Generate an Ed25519 key pair
const ed25519Key = await Ed25519VerificationKey2020.generate();

// Generate a Secp256k1 key pair
const secp256k1Key = await Secp256k1KeyPair.generate();
```

### Signing and Verifying

```typescript
import { Ed25519VerificationKey2020 } from 'di-wings';

const key = await Ed25519VerificationKey2020.generate();
const data = new TextEncoder().encode('Hello, world!');

// Signing
const signature = await key.sign(data);

// Verifying
const isValid = await key.verify(data, signature);
console.log('Signature is valid:', isValid);
```

### JSON Web Signatures (JWS)

```typescript
import { JsonWebSignature2020Suite, JsonWebKeyPair } from 'di-wings';

const key = await JsonWebKeyPair.generate({ kty: 'EC', crv: 'secp256k1' });
const suite = new JsonWebSignature2020Suite({ key });

// Signing
const jws = await suite.sign(Buffer.from('Hello, world!'));

// Verifying
const result = await suite.verify(Buffer.from('Hello, world!'), key, { jws });
console.log('JWS verification result:', result.verified);
```

### JSON Web Encryption (JWE)

```typescript
import { JsonWebEncryptionSuite, X25519KeyAgreementKey2019 } from 'di-wings';

const aliceKey = await X25519KeyAgreementKey2019.generate();
const bobKey = await X25519KeyAgreementKey2019.generate();

const cipher = new JsonWebEncryptionSuite();

// Encrypting
const jwe = await cipher.encrypt({
  data: { secret: 'Hello, Bob!' },
  recipients: [{ header: { kid: bobKey.id, alg: 'ECDH-ES+A256KW' } }],
  publicKeyResolver: () => bobKey
});

// Decrypting
const decrypted = await cipher.decrypt({ jwe, keyAgreementKey: bobKey });
console.log('Decrypted message:', decrypted.secret);
```

### Mnemonics and HD Wallets

```typescript
import { entropyToMnemonic, mnemonicToSeed, seedToHD } from 'di-wings';

// Generate a mnemonic
const entropy = crypto.getRandomValues(new Uint8Array(16));
const mnemonic = entropyToMnemonic(entropy);

// Convert mnemonic to seed
const seed = mnemonicToSeed(mnemonic);

// Create an HD wallet
const masterKey = seedToHD(seed);
```

## Using Verifiable Credentials (VC) Libraries

DI-Wings includes support for Verifiable Credentials, allowing you to issue, verify, and manage VCs easily. The library now provides a unified API for working with both v1 and v2 of Verifiable Credentials, automatically detecting which version to use based on the `@context` of the credential or presentation.

### Issuing a Verifiable Credential

To issue a Verifiable Credential:

1. Import the necessary modules:
   import { Issuer, Multikey } from 'di-wings';
   import { documentLoader } from './your-document-loader';

2. Generate a Multikey:
   const key = await Multikey.generate('Ed25519');

3. Issue the credential:
   const verifiableCredential = await Issuer.issue(credential, {
     verificationMethod: key.id,
     proofPurpose: 'assertionMethod',
     documentLoader
   });

### Presenting a Verifiable Credential

To present a Verifiable Credential:

1. Import the necessary modules:
   import { Issuer } from 'di-wings';
   import { documentLoader } from './your-document-loader';

2. Create a presentation:
   const presentation = {
      '@context': [
         'https://www.w3.org/ns/credentials/v2'
      ],
      type: ['VerifiablePresentation'],
      verifiableCredential: [verifiableCredential]
   };

3. Issue the presentation:
   const verifiablePresentation = await Issuer.issuePresentation(presentation, {
     documentLoader
   });

### Verifying a Verifiable Credential

To verify a Verifiable Credential:

1. Import the necessary modules:
   import { Verifier } from 'di-wings';
   import { documentLoader } from './your-document-loader';

2. Verify the credential:
   const result = await Verifier.verifyCredential(verifiableCredential, {
     documentLoader
   });

   console.log('Verification Result:', result.verified);

### Verifying a Verifiable Presentation

To verify a Verifiable Presentation:

1. Import the necessary modules:
   import { Verifier } from 'di-wings';
   import { documentLoader } from './your-document-loader';

2. Verify the presentation:
   const result = await Verifier.verifyPresentation(verifiablePresentation, {
     documentLoader
   });

   console.log('Presentation Verification Result:', result.verified);

The `Issuer` and `Verifier` classes automatically determine whether to use v1 or v2 based on the `@context` of the credential or presentation. For v2 credentials and presentations, the first element of the `@context` array should be "https://www.w3.org/ns/credentials/v2".

Note that the API remains consistent for both v1 and v2, allowing for easy integration and migration between versions.

## Using DID Libraries

DI-Wings now includes support for Decentralized Identifiers (DIDs), allowing you to resolve, manage, and work with various DID methods. Here's how to use the DID libraries:

### Resolving DIDs

```typescript
import { DIDResolver } from 'di-wings';

const resolver = new DIDResolver();

// Resolve a did:web
const webDID = await resolver.resolve("did:web:example.com");
console.log('Resolved did:web:', webDID);

// Resolve a did:key
const keyDID = await resolver.resolve("did:key:z6MkjdxYZ17j7DNPfgSB5LviYRxTCXPunZ5Vfbm5QKCEBVgt");
console.log('Resolved did:key:', keyDID);

// Resolve a did:peer
const peerDID = await resolver.resolve("did:peer:0z6MkqRYqQiSgvZQdnBytw86Qbs2ZWUkGv22od935YF4s8M7V");
console.log('Resolved did:peer:', peerDID);
```

### Working with DID Documents

```typescript
import { DIDDocument } from 'di-wings';

// Create a DID Document from a resolved DID
const didDocument = new DIDDocument(resolvedDID);

// Get verification methods
const verificationMethods = didDocument.verificationMethod;

// Get authentication methods
const authMethods = didDocument.authentication;

// Get key agreement methods
const keyAgreementMethods = didDocument.keyAgreement;

// Get a specific verification method by ID
const specificMethod = didDocument.getVerificationMethodById("did:example:123#key-1");

// Get a service by ID or type
const service = didDocument.getServiceById("did:example:123#service-1");
const didCommService = didDocument.getServiceByType("DIDCommMessaging");
```

### Managing Secrets

```typescript
import { Secret, JSONSecretResolver, EnvironmentVariableSecretResolver } from 'di-wings';

// Create a secret from a JSON object
const jsonSecret = new Secret({
  id: "did:example:123#key-1",
  type: "JsonWebKey2020",
  privateKeyJwk: { /* JWK data */ }
});

// Use a JSON-based secret resolver
const jsonResolver = new JSONSecretResolver({
  id: "did:example:123#key-1",
  type: "JsonWebKey2020",
  privateKeyJwk: { /* JWK data */ }
});

const resolvedSecret = await jsonResolver.resolve("did:example:123#key-1");

// Use an environment variable-based secret resolver
const envResolver = new EnvironmentVariableSecretResolver(process.env);
const envSecret = await envResolver.resolve("did:example:123#key-1");

// Convert a secret to a JsonWebKey2020
const jwk = await resolvedSecret.asJsonWebKey();
```

These examples demonstrate how to use the DID libraries in DI-Wings to work with Decentralized Identifiers, DID Documents, and manage secrets associated with DIDs. The library supports various DID methods and provides flexibility in how secrets are stored and resolved.

For more detailed documentation and advanced usage, please refer to the API documentation.
