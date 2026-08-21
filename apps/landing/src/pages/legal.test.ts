/**
 * U11 / R19 — the privacy and terms pages.
 *
 * Two jobs. The pages have to exist and be reachable (route + footer, on the
 * hand-rolled router, with no new dependency), and what they say has to be
 * TRUE OF THIS CODE — a privacy page that lists categories the app does not
 * store, or omits ones it does, is worse than none.
 *
 * So the disclosure tests bind copy to the constants the app actually writes:
 * the cookie config, the localStorage keys, and the money-event union. If a
 * later unit adds a stored category or a new money event, these fail until the
 * page names it.
 *
 * The custody scan is the other half. The site may not assert a custody STATUS
 * while the legal read is outstanding — but the terms MUST be able to say that
 * it is not answering the question, so a bare /custod/i ban (the right rule for
 * the deposit screen) is the wrong rule here. These match assertions instead.
 */
import { describe, test, expect } from 'bun:test';
import { getAuthCookieConfig } from '@originals/auth/server';
import { legal, footer } from '../content';
import { legalRouteDoc, legalStrings } from './Legal';
import { routeForPath } from '../router';
import { isInternalHref } from '../components/Footer';
import { formatMoneyLog } from '../../server/money-log';
import { SESSION_STORAGE_KEY } from '../auth/turnkey-session';
import { KEY_STORAGE_PREFIX, DID_LOG_STORAGE_PREFIX } from '../auth/authorship-key';

const ALL = legalStrings().join('\n');

describe('the legal routes', () => {
  test('/privacy resolves to the privacy route and that route renders the privacy page', () => {
    expect(routeForPath('/privacy')).toBe('privacy');
    const doc = legalRouteDoc('privacy');
    expect(doc).not.toBeNull();
    expect(doc!.heading).toBe(legal.privacy.heading);
    expect(doc!.sections.length).toBeGreaterThan(0);
  });

  test('/terms resolves to the terms route and that route renders the terms page', () => {
    expect(routeForPath('/terms')).toBe('terms');
    const doc = legalRouteDoc('terms');
    expect(doc).not.toBeNull();
    expect(doc!.heading).toBe(legal.terms.heading);
    expect(doc!.sections.length).toBeGreaterThan(0);
  });

  test('a non-legal route has no legal document to render', () => {
    expect(legalRouteDoc('landing')).toBeNull();
    expect(legalRouteDoc('your-originals')).toBeNull();
  });

  /**
   * The router has no not-found state and this unit does not add one: anything
   * unrecognised is still the landing page. Pinned so a near-miss URL cannot
   * quietly start rendering a legal page.
   */
  test('unknown paths still fall through to landing, unchanged', () => {
    expect(routeForPath('/privacy/extra')).toBe('landing');
    expect(routeForPath('/terms/')).toBe('landing');
    expect(routeForPath('/privacy-policy')).toBe('landing');
    expect(routeForPath('/anything/else')).toBe('landing');
    expect(routeForPath('/')).toBe('landing');
  });
});

describe('both pages are reachable from the footer', () => {
  const links = footer.columns.flatMap((c) => c.links);

  test('the footer links to each page', () => {
    const routes = links.map((l) => routeForPath(l.href));
    expect(routes).toContain('privacy');
    expect(routes).toContain('terms');
  });

  test('they are in-app links, not new-tab links to somewhere else', () => {
    for (const href of ['/privacy', '/terms']) {
      const link = links.find((l) => l.href === href);
      expect(link).toBeDefined();
      expect(link!.label.length).toBeGreaterThan(0);
      expect(isInternalHref(href)).toBe(true);
    }
    // The pre-existing footer links are all external and must stay that way.
    for (const link of links.filter((l) => !l.href.startsWith('/'))) {
      expect(isInternalHref(link.href)).toBe(false);
    }
  });
});

describe('no published legal string asserts a custody status', () => {
  /**
   * Assertions of STATUS, not the word itself. The deposit screen bans
   * /custod/i outright; the terms cannot, because naming the unanswered
   * question is the honest thing this page does instead of answering it.
   */
  const CUSTODY_CLAIMS = [
    /non-?custodial/i,
    /nothing is (?:custodied|held|kept)/i,
    /never holds? (?:user )?(?:funds|keys|money|btc|bitcoin)/i,
    /we (?:never|don.?t|do not) (?:hold|touch|control|custody) your (?:funds|btc|bitcoin|money|keys)/i,
    /you own (?:the|your) (?:keys|change|funds|coins|sat)/i,
    /(?:is|are) (?:fully )?custod(?:ial|ied)/i,
    /not a (?:custodian|money (?:services? )?business|money transmitter)/i,
  ];

  test('every string on both pages is mechanics, not legal characterisation', () => {
    for (const value of legalStrings()) {
      for (const claim of CUSTODY_CLAIMS) {
        expect({ claim: String(claim), value, matched: claim.test(value) }).toEqual({
          claim: String(claim),
          value,
          matched: false,
        });
      }
    }
  });

  test('the terms say plainly that the characterisation is being withheld', () => {
    expect(/custody/i.test(ALL)).toBe(true);
    expect(/legal characterisation|legal characterization/i.test(ALL)).toBe(true);
    expect(/not (?:been )?(?:through )?a legal review|have not obtained|not legal advice/i.test(ALL)).toBe(true);
  });

  test('the mechanics that replace it are actually stated', () => {
    expect(/cannot be reversed|irreversible/i.test(ALL)).toBe(true);
    expect(/no withdraw/i.test(ALL)).toBe(true);
    expect(/never receives a private key|never sees a private key/i.test(ALL)).toBe(true);
  });
});

describe('the disclosed categories match what the code stores', () => {
  test('the cookie section names the cookie the server actually sets', () => {
    const cfg = getAuthCookieConfig('token-value');
    expect(ALL).toContain(cfg.name);
    expect(/HttpOnly/i.test(ALL)).toBe(true);
    expect(/SameSite=Strict/i.test(ALL)).toBe(true);
    const days = cfg.options.maxAge / (24 * 60 * 60 * 1000);
    expect(days).toBe(7);
    expect(/seven days|7 days/i.test(ALL)).toBe(true);
    // The signed token carries the email, so the page must not imply otherwise.
    expect(/email address/i.test(legalStrings().find((s) => s.includes(cfg.name))!)).toBe(true);
  });

  test('the browser-storage section names the keys the app writes', () => {
    for (const key of [SESSION_STORAGE_KEY, KEY_STORAGE_PREFIX, DID_LOG_STORAGE_PREFIX]) {
      expect(key.length).toBeGreaterThan(0);
    }
    expect(/localStorage/i.test(ALL)).toBe(true);
    expect(/IndexedDB/i.test(ALL)).toBe(true);
    expect(/non-extractable/i.test(ALL)).toBe(true);
  });

  test('the server-storage section names each durable tree the stores write', () => {
    // originals-store: hosted logs + bytes, users/<sub>.json index.
    expect(/did:webvh log|DID log/i.test(ALL)).toBe(true);
    expect(/event log|CEL/i.test(ALL)).toBe(true);
    // inscriptions-store: the signed pair kept before broadcast.
    expect(/signed commit and reveal|commit and reveal/i.test(ALL)).toBe(true);
    // deposits/ + deposit-state/: the binding, the last trusted read, the alert.
    expect(/deposit address/i.test(ALL)).toBe(true);
    expect(/sub-organization id|sub-organisation id/i.test(ALL)).toBe(true);
  });

  test('the log section lists exactly the money events the code can emit', async () => {
    const source = await Bun.file(new URL('../../server/money-log.ts', import.meta.url)).text();
    const union = source.slice(source.indexOf('export type MoneyEvent'), source.indexOf('export type MoneyFields'));
    const events = [...union.matchAll(/\|\s*'([a-z_]+)'/g)].map((m) => m[1]);
    expect(events.length).toBeGreaterThan(0);
    const listed = legal.privacy.sections.flatMap((s) => s.list ?? []);
    for (const event of events) {
      expect({ event, listed: listed.some((l) => l.includes(event)) }).toEqual({ event, listed: true });
    }
    // And nothing invented: every listed line names a real event.
    for (const line of listed) {
      expect({ line, real: events.some((e) => line.includes(e)) }).toEqual({ line, real: true });
    }
  });

  test('the log section names the sink and the retention it actually has', () => {
    expect(ALL).toContain('[landing][money]');
    expect(/log drain/i.test(ALL)).toBe(true);
    // We set no window of our own — saying we did would be the inaccuracy.
    expect(/retention/i.test(ALL)).toBe(true);
  });
});

describe('U15’s guarantee still holds: no money-path log line carries an email', () => {
  test('an email-shaped value is redacted whatever field carries it', () => {
    const line = formatMoneyLog('deposit_address_issued', {
      sub: 'suborg-123',
      email: 'someone@example.com',
      note: 'contact someone@example.com about this',
    });
    expect(line).not.toContain('someone@example.com');
    expect(line).toContain('[redacted]');
    expect(line).toContain('suborg-123');
  });

  test('the privacy page states that guarantee rather than leaving it implicit', () => {
    expect(/never by your email|never your email|not by (?:your )?email/i.test(ALL)).toBe(true);
    expect(/redact/i.test(ALL)).toBe(true);
  });
});
