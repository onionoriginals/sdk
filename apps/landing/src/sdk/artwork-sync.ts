/**
 * Shared artwork seed — keeps the hero halo and the demo's asset in sync.
 *
 * The demo owns the seed (title + style + regenerate nonce); the hero
 * subscribes and renders the same artwork as an ambient halo. On first load
 * both show the same fresh piece (random nonce per visit); every edit,
 * regenerate, or start-over in the demo updates the hero too.
 */
import { ART_STYLES, generateName } from './artwork';

export interface ArtSeed {
  title: string;
  style: string;
  nonce: number;
}

const initialNonce = Math.floor(Math.random() * 1e9); // a fresh original per visit

let seed: ArtSeed = {
  // Named from the same seed as the picture, so the first thing a visitor sees
  // is a titled piece rather than a placeholder asking them to invent one.
  title: generateName(ART_STYLES[0], initialNonce),
  style: ART_STYLES[0],
  nonce: initialNonce
};

const listeners = new Set<() => void>();

export function getArtSeed(): ArtSeed {
  return seed;
}

export function setArtSeed(next: ArtSeed): void {
  if (
    next.title === seed.title &&
    next.style === seed.style &&
    next.nonce === seed.nonce
  ) {
    return;
  }
  seed = next;
  for (const listener of listeners) listener();
}

export function subscribeArtSeed(callback: () => void): () => void {
  listeners.add(callback);
  return () => listeners.delete(callback);
}
