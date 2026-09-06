/** Stable account keys shared by creator state and engine selection. */
export const ANON_IDENTITY = "anon";

export function engineIdentity(authed: boolean, subOrgId?: string): string {
  return authed ? `authed:${subOrgId ?? ""}` : ANON_IDENTITY;
}
