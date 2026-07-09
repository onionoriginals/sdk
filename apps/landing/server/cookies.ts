export function parseCookies(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of header.split(';')) {
    const [name, ...rest] = pair.trim().split('=');
    if (name) out[name] = rest.join('='); // values may contain '='
  }
  return out;
}

export function extractToken(req: Request, cookieName = 'auth_token'): string | null {
  const auth = req.headers.get('Authorization');
  if (auth?.startsWith('Bearer ')) return auth.slice(7);
  const cookie = req.headers.get('Cookie');
  if (cookie) {
    const cookies = parseCookies(cookie);
    if (cookies[cookieName]) return cookies[cookieName];
  }
  return null;
}

interface CookieConfig {
  name: string;
  value: string;
  options: {
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: 'strict' | 'lax' | 'none';
    maxAge?: number;
    path?: string;
  };
}

export function serializeCookie(cfg: CookieConfig): string {
  const o = cfg.options;
  const parts = [`${cfg.name}=${cfg.value}`];
  if (o.maxAge != null) parts.push(`Max-Age=${o.maxAge}`);
  if (o.path) parts.push(`Path=${o.path}`);
  if (o.httpOnly) parts.push('HttpOnly');
  if (o.secure) parts.push('Secure');
  if (o.sameSite) parts.push(`SameSite=${o.sameSite[0].toUpperCase()}${o.sameSite.slice(1)}`);
  return parts.join('; ');
}
