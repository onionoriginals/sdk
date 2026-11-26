/**
 * A browser-local author for visitors who are not signed in: a did:vh whose
 * log and keys can be saved in guest browser storage. The SDK makes it
 * (`createLocalAuthor`): its update key and its author key are different keys
 * (P5.11), and the author key is the document's assertionMethod (P5.3).
 * Nothing about it is published; an Original it authors verifies anywhere
 * through the evidence package, which carries this DID's log.
 */
export { createLocalAuthor, restoreLocalAuthor, type LocalAuthor } from "@originals/sdk/originals";
