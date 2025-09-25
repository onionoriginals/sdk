import { Elysia, t } from 'elysia';
import { z } from 'zod';
import { Issuer, Verifier, base64, utf8, Credential, VerifiableCredential, VerifiablePresentation } from 'di-wings';

const app = new Elysia()
  .onAfterResponse(({ request, response }) => {
    console.log((response as any).status, request.method, request.url);
  })
  .onError(({ error }) => {
    console.error(error);
    return Response.json({ errors: [error.message] }, { status: 400 });
  });

const didVerificationMethods = utf8.decode(base64.decode(process.env.DID_VERIFICATION_METHODS));
if (!didVerificationMethods) {
  throw new Error('DID_VERIFICATION_METHODS environment variable is not set');
}
const verificationMethods = JSON.parse(didVerificationMethods);

// Function to list active DIDs
function listActiveDIDs(verificationMethods: any[]): void {
  console.log('Active DIDs:');
  const uniqueDIDs = new Set(verificationMethods.map(vm => vm.controller));
  uniqueDIDs.forEach(did => console.log(`- ${did}`));
}

// List active DIDs when the server boots up
listActiveDIDs(verificationMethods);

const credentialSchema = z.object({
  credential: z.object({}).passthrough(), // Define more specific schema if needed
  options: z.object({
    proofPurpose: z.string().optional(),
  }).optional(),
});

const verifiableCredentialSchema = z.object({
  verifiableCredential: z.object({}).passthrough(), // Define more specific schema if needed
  options: z.object({}).optional(),
});

const verifiablePresentationSchema = z.object({
  verifiablePresentation: z.object({}).passthrough(), // Define more specific schema if needed
});

app.post('/credentials/issue', async ({ body }) => {
  const { credential, options } = credentialSchema.parse(body);
  const issuerId = typeof credential.issuer === 'string' ? credential.issuer : (credential.issuer as { id: string }).id;

  try {
    console.log('issuerId', issuerId);
    const verificationMethod = verificationMethods.find(vm => vm.controller === issuerId);
    console.log('verificationMethod', verificationMethod);
    if (!verificationMethod) {
      throw new Error(`Verification method not found for issuer: ${issuerId}`);
    }
    const result = await Issuer.issue(credential as unknown as Credential, {
      verificationMethod,
      proofPurpose: options?.proofPurpose || 'assertionMethod'
    });
    return result;
  } catch (error) {
    console.error("Error in /credentials/issue:", error);
    return Response.json({ errors: [error.message] }, { status: 400 });
  }
});

app.post('/credentials/verify', async ({ body }) => {
  try {
    const { verifiableCredential, options } = verifiableCredentialSchema.parse(body);
    const verifier = new Verifier();
    const result = await verifier.verifyCredential(verifiableCredential as unknown as VerifiableCredential, options);
    if (result.verified) {
      return Response.json({ verified: true });
    } else {
      return Response.json({ verified: false, errors: result.errors }, { status: 400 });
    }
  } catch (error) {
    return Response.json({ errors: [error.message] }, { status: 400 });
  }
});

app.post('/presentations/verify', async ({ body }) => {
  try {
    const { verifiablePresentation } = verifiablePresentationSchema.parse(body);
    const verifier = new Verifier();
    const {verified, errors} = await verifier.verifyPresentation(verifiablePresentation as unknown as VerifiablePresentation);
    if (verified) {
      return Response.json({ verified: true, errors: [] });
    } else {
      return Response.json(JSON.stringify({ verified: false, errors }), { status: 400 });
    }
  } catch (error) {
    return Response.json({ verified: false, errors: [error.message] }, { status: 400 });
  }
});

app.get("/", () => "Server is running");

app.listen(3000);
app.routes.forEach(route => console.log(`${route.method} ${route.path}`));
console.log('Server is running on http://localhost:3000');
