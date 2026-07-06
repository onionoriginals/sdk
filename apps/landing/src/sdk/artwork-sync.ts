/**
 * Shared artwork seed — keeps the hero halo and the demo's asset in sync.
 *
 * The demo owns the seed (title + medium + regenerate nonce); the hero
 * subscribes and renders the same artwork as an ambient halo. On first load
 * both show the same fresh piece (random nonce per visit); every edit,
 * regenerate, or start-over in the demo updates the hero too.
 */
import { demo } from '../content';

export interface ArtSeed {
  title: string;
  medium: string;
  nonce: number;
}

let seed: ArtSeed = {
  title: demo.form.defaultTitle,
  medium: demo.form.mediums[0],
  nonce: Math.floor(Math.random() * 1e9) // a fresh original per visit
};

const listeners = new Set<() => void>();

export function getArtSeed(): ArtSeed {
  return seed;
}

export function setArtSeed(next: ArtSeed): void {
  if (
    next.title === seed.title &&
    next.medium === seed.medium &&
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
