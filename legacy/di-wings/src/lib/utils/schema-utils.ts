import { t } from 'elysia';
import type { Presentation } from '../vcs/v2/models/presentation';

type SchemaType = {
  [K in keyof Presentation]: any;
};

export function createPresentationSchema(): SchemaType {
  return {
    '@context': t.Array(t.String()),
    id: t.Optional(t.String()),
    type: t.Array(t.String()),
    verifiableCredential: t.Array(t.Any()),
    holder: t.Optional(t.Union([t.String(), t.Object({ id: t.String() })]))
  };
}
