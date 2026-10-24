import { useEffect, useState } from 'react';
import { YourOriginals } from './pages/YourOriginals';
import { useAuth } from './auth/useAuth';
import { Nav } from './components/Nav';
import { Hero } from './components/Hero';
import { Why } from './components/Why';
import { Demo } from './components/Demo';
import { RealExample } from './components/RealExample';
import { Protocol } from './components/Protocol';
import { Developers } from './components/Developers';
import { Footer } from './components/Footer';
import { useLocationPath, routeForPath } from './router';
import { LegalPage, legalRouteDoc } from './pages/Legal';
import { smokeAutoRunAllowed } from './sdk/network-flag';
import { RecordLine } from './components/RecordLine';
import './design/eclipse.css';
import './design/eclipse-pages.css';

export function App() {
  if (new URLSearchParams(location.search).has('smoke')) {
    return <SmokeTest />;
  }
  return <RoutedApp />;
}

function RoutedApp() {
  const path = useLocationPath();
  const route = routeForPath(path);
  const legalDoc = legalRouteDoc(route);
  return (
    <div className={`eclipse${route === 'landing' ? '' : ' eclipse-interior'}`}>
      <Nav />
      {legalDoc ? (
        <LegalPage doc={legalDoc} />
      ) : route === 'originals' ? <YourOriginals /> : (
        <main>
          <Hero />
          <RecordLine />
          <Why />
          <AccountDemo />
          <RealExample />
          <Protocol />
          <Developers />
        </main>
      )}
      <Footer closing={route === 'landing'} />
    </div>
  );
}

/**
 * Headless CI harness (?smoke=1): creates a signed Original, packages its
 * evidence, and verifies that package in a fresh SDK with no key (spec section
 * 7), then dumps the result for scripts/smoke.mjs to assert on. Not linked
 * from the page.
 *
 * R12: the auto-run is MOCK-BUILD ONLY. It executes unauthenticated on load,
 * so on a real-network build it would drive the real provider path from an
 * anonymous page load. It stays a harness marker (not product copy in
 * content.ts) — and it deliberately reads as an ERROR so a smoke run pointed
 * at a real-network build fails loudly instead of passing vacuously.
 */
const SMOKE_DISABLED_OUTPUT =
  'ERROR: ?smoke=1 auto-run is disabled on a real-network build (VITE_BTC_NETWORK is not off). ' +
  'Run the smoke harness against a mock build.';

function SmokeTest() {
  const [out, setOut] = useState('booting');
  useEffect(() => {
    if (!smokeAutoRunAllowed()) {
      setOut(SMOKE_DISABLED_OUTPUT);
      return;
    }
    (async () => {
      const [{ DemoEngine }, { generateArtwork }] = await Promise.all([
        import('./sdk/engine'),
        import('./sdk/artwork')
      ]);
      const engine = new DemoEngine();
      const events: string[] = [];
      engine.on((e) => events.push(e.type));
      const art = generateArtwork('Smoke Test', 'Artwork', 1);
      const s1 = await engine.create('Smoke Test', 'Artwork', art.svg);
      const { OriginalsSDK, MemoryStore } = await import('@originals/sdk/originals');
      const reader = OriginalsSDK.create({ store: new MemoryStore(), authors: [] });
      const { report } = await reader.load(await engine.evidencePackage());
      const verified = report.history.status === 'valid' && report.authorBinding.status === 'valid' &&
        report.identityEvidence.status === 'complete' && report.resources.status === 'available';
      if (!verified || report.original !== s1.did) {
        throw new Error('Fresh verification of the evidence package did not reproduce the same Original');
      }
      setOut(
        JSON.stringify(
          { layer: s1.layer, assetId: report.original, verified: true, events },
          null,
          2
        )
      );
    })().catch((e) => setOut('ERROR: ' + (e as Error).stack));
  }, []);
  return <pre id="smoke-out">{out}</pre>;
}

function AccountDemo() {
  const { user, isLoading } = useAuth();
  return isLoading ? null : <Demo key={user?.subOrgId ?? 'guest'} />;
}
