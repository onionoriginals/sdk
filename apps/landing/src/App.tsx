import { useEffect, useState } from 'react';
import { Nav } from './components/Nav';
import { Hero } from './components/Hero';
import { Why } from './components/Why';
import { Demo } from './components/Demo';
import { Protocol } from './components/Protocol';
import { Developers } from './components/Developers';
import { Footer } from './components/Footer';

export function App() {
  if (new URLSearchParams(location.search).has('smoke')) {
    return <SmokeTest />;
  }
  return (
    <>
      <Nav />
      <main>
        <Hero />
        <Why />
        <Demo />
        <Protocol />
        <Developers />
      </main>
      <Footer />
    </>
  );
}

/**
 * Headless CI harness (?smoke=1): runs the full real-SDK lifecycle and dumps
 * the result for scripts/smoke.mjs to assert on. Not linked from the page.
 */
function SmokeTest() {
  const [out, setOut] = useState('booting');
  useEffect(() => {
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
      const s2 = await engine.publish();
      const s3 = await engine.inscribe(7);
      setOut(
        JSON.stringify(
          { l1: s1.layer, l2: s2.layer, l3: s3.layer, events, tx: s3.inscription?.txid },
          null,
          2
        )
      );
    })().catch((e) => setOut('ERROR: ' + (e as Error).stack));
  }, []);
  return <pre id="smoke-out">{out}</pre>;
}
