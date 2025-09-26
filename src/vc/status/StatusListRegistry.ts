import { VerifiableCredential } from '../../types';

type ListState = {
  revokedIndices: Set<number>;
};

const listRegistry: Map<string, ListState> = new Map();
const directStatusRegistry: Map<string, boolean> = new Map();

export function updateStatusList(listId: string, revokedIndices: number[] | Set<number>): void {
  const set = revokedIndices instanceof Set ? new Set(revokedIndices) : new Set(revokedIndices);
  listRegistry.set(listId, { revokedIndices: set });
}

export function setStatusListIndex(listId: string, index: number, revoked: boolean): void {
  const state = listRegistry.get(listId) || { revokedIndices: new Set<number>() };
  if (revoked) state.revokedIndices.add(index);
  else state.revokedIndices.delete(index);
  listRegistry.set(listId, state);
}

export function setDirectCredentialStatus(statusId: string, revoked: boolean): void {
  directStatusRegistry.set(statusId, revoked);
}

export function isCredentialRevoked(vc: VerifiableCredential): boolean {
  const status: any = (vc as any).credentialStatus;
  if (!status) return false;
  // Status List 2021-like
  if (status.statusListCredential && (status.statusListIndex || status.statusListIndex === 0)) {
    const listId = String(status.statusListCredential);
    const index = Number(status.statusListIndex);
    const state = listRegistry.get(listId);
    return state ? state.revokedIndices.has(index) : false;
  }
  // Direct mapping fallback by credentialStatus.id
  if (status.id) {
    return directStatusRegistry.get(String(status.id)) === true;
  }
  return false;
}

