import { webvhTspInboxUrl, webvhTspInboxUrlFromPublishingAddress } from '@originals/tsp';

export type TspWebvhEnable = boolean | { transport?: string };

export function resolveTspTransportUrl(
  tsp: TspWebvhEnable | undefined,
  ctx: { domain: string; paths?: string[]; did?: string },
): string | undefined {
  if (!tsp) return undefined;
  if (typeof tsp === 'object' && tsp.transport) return tsp.transport;
  if (ctx.did) return webvhTspInboxUrl(ctx.did);
  return webvhTspInboxUrlFromPublishingAddress(ctx.domain, ctx.paths ?? []);
}