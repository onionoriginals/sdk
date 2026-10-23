import { useEffect, useState } from 'react';
import type { DemoEngine, StoredOriginalSummary } from '../sdk/engine';
import { demo } from '../content';

/**
 * A signed-in author's Originals (#976 B3, gap G3): the ones this browser
 * keeps, and the ones published from another device, which restore from the
 * host. Picking one hands it to `onPick`; the engine verifies it either way.
 */
export function YourOriginals({
  getEngine,
  onPick,
  disabled,
}: {
  getEngine: () => Promise<DemoEngine>;
  onPick: (original: StoredOriginalSummary) => void;
  disabled: boolean;
}) {
  const [originals, setOriginals] = useState<StoredOriginalSummary[] | null>(null);

  useEffect(() => {
    let live = true;
    void getEngine()
      .then((engine) => engine.listOriginals())
      .then((list) => live && setOriginals(list))
      .catch(() => live && setOriginals([]));
    return () => {
      live = false;
    };
  }, [getEngine]);

  if (!originals || originals.length === 0) return null;
  return (
    <div className="demo-yours">
      <p className="demo-yours-heading">{demo.yours.heading}</p>
      <ul>
        {originals.map((o) => (
          <li key={o.did}>
            <span className="demo-yours-name">{o.name}</span>
            {o.where === 'host' && <span className="demo-yours-note">{demo.yours.elsewhere}</span>}
            <button type="button" className="btn btn-ghost" disabled={disabled} onClick={() => onPick(o)}>
              {o.where === 'host' ? demo.yours.restore : demo.yours.open}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
