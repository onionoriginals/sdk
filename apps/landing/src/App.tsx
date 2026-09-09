import { Explore } from './pages/Explore';
import { ExploreOriginal } from './pages/ExploreOriginal';
import { exploreDidFromPath } from './router';
import { useEffect, useState } from 'react';
import { Nav } from './components/Nav';
import { Hero } from './components/Hero';
import { Why } from './components/Why';
import { Demo } from './components/Demo';
import { RealExample } from './components/RealExample';
import { Protocol } from './components/Protocol';
import { Developers } from './components/Developers';
import { Footer } from './components/Footer';
import { useLocationPath, routeForPath, didFromPath } from './router';
import { YourOriginals } from './pages/YourOriginals';
import { OriginalDetail } from './pages/OriginalDetail';
import { LegalPage, legalRouteDoc } from './pages/Legal';
import { smokeAutoRunAllowed } from './sdk/network-flag';

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
    <>
      <Nav />
      {route === 'explore' ? <Explore /> : route === 'explore-original' ? <ExploreOriginal did={exploreDidFromPath(path)!} /> : legalDoc ? (
        <LegalPage doc={legalDoc} />
      ) : route === 'original-detail' ? (
        <OriginalDetail did={didFromPath(path)!} />
      ) : route === 'your-originals' ? (
        <YourOriginals />
      ) : (
        <main>
          <Hero />
          <Why />
          <Demo />
          <RealExample />
          <Protocol />
          <Developers />
        </main>
      )}
      <Footer />
    </>
  );
}

/**
 * Headless CI harness (?smoke=1): creates and independently reloads a local signed asset, then dumps
 * the result for scripts/smoke.mjs to assert on. Not linked from the page.
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
      const { OriginalsSDK } = await import('@originals/sdk');
      const envelope = JSON.stringify(engine.asset!.serialize());
      const recovered = await OriginalsSDK.create().lifecycle.loadAsset(envelope);
      if (!recovered.verification.verified || recovered.asset.id !== engine.asset!.id) {
        throw new Error('Fresh local verification did not recover the same asset');
      }
      setOut(
        JSON.stringify(
          { layer: s1.layer, assetId: recovered.asset.id, verified: true, events },
          null,
          2
        )
      );
    })().catch((e) => setOut('ERROR: ' + (e as Error).stack));
  }, []);
  return <pre id="smoke-out">{out}</pre>;
}
