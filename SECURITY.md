# Security Policy

## Reporting a Vulnerability

The Originals SDK team takes security seriously. We appreciate your efforts to responsibly disclose security vulnerabilities.

### How to Report a Security Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Instead, please report security vulnerabilities by using GitHub's private vulnerability reporting feature:

1. Go to the **Security** tab of this repository
2. Click on **Report a vulnerability**
3. Fill out the form with details about the vulnerability

You should receive a response within 48 hours. If for some reason you do not, please create a private security advisory.

Please include the following information in your report:

- Type of vulnerability (e.g., cryptographic issue, injection, authentication bypass)
- Full paths of source file(s) related to the manifestation of the vulnerability
- The location of the affected source code (tag/branch/commit or direct URL)
- Any special configuration required to reproduce the issue
- Step-by-step instructions to reproduce the issue
- Proof-of-concept or exploit code (if possible)
- Impact of the issue, including how an attacker might exploit it

This information will help us triage your report more quickly.

### What to Expect

After you submit a report, we will:

1. **Acknowledge** your report within 48 hours
2. **Investigate** and validate the vulnerability
3. **Develop and test** a fix
4. **Release** a security update
5. **Publicly disclose** the vulnerability after a fix is available (with your consent, we may credit you for the discovery)

### Scope

The following are in scope for vulnerability reports:

- **Cryptographic operations**: Key generation, signing, verification in `src/crypto/` and `src/did/KeyManager.ts`
- **Bitcoin operations**: Transaction building, inscription handling, UTXO management in `src/bitcoin/`
- **DID operations**: DID creation, resolution, migration in `src/did/`
- **Verifiable Credentials**: Credential issuance, signing, verification in `src/vc/`
- **Input validation**: Any public API that accepts external input
- **Dependency vulnerabilities**: Issues in third-party dependencies

### Out of Scope

The following are generally out of scope:

- Vulnerabilities in example code or test code (though we still appreciate reports)
- Issues requiring physical access to a user's device
- Social engineering attacks
- Denial of Service (DoS) attacks without significant impact
- Issues in legacy code under `legacy/` directory (deprecated components)

### Security Best Practices for SDK Users

When using the Originals SDK in production:

1. **Key Management**: Never expose private keys. Use secure key storage (HSM, key vaults, encrypted storage)
2. **Network Security**: Use HTTPS for all web-based operations (did:webvh, storage adapters)
3. **Bitcoin Operations**: 
   - Test thoroughly on testnet/signet before mainnet
   - Implement proper fee estimation to avoid stuck transactions
   - Validate all Bitcoin addresses before sending funds
4. **Input Validation**: Always validate and sanitize user input before passing to SDK methods
5. **Error Handling**: Implement proper error handling; don't expose sensitive error details to end users
6. **Dependencies**: Keep the SDK and its dependencies up to date
7. **Telemetry**: Enable telemetry in development but review logs for sensitive data before production

### Security Updates

Security updates will be released as patch versions (e.g., 1.0.1) and announced via:

- GitHub Security Advisories
- Release notes
- npm package updates

We recommend using automated dependency update tools (Dependabot, Renovate) to stay current with security patches.

### Bug Bounty Program

At this time, we do not have a formal bug bounty program. However, we deeply appreciate security researchers who help us improve the security of the Originals SDK. We will acknowledge your contributions in our security advisories (with your permission).

---

Thank you for helping keep the Originals SDK and its users safe!
