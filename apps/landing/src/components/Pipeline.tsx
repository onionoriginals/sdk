import { useEffect, useState } from 'react';
import { layers } from '../content';
import './pipeline.css';

const glyphs: Record<string, JSX.Element> = {
  'did:peer': (
    // pencil / draft
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M10.9 2.6a1.6 1.6 0 0 1 2.3 2.3l-7.4 7.4-3 .7.7-3 7.4-7.4Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  ),
  'did:webvh': (
    // globe
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="5.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M2.4 8h11.2M8 2.4c-3.4 3.4-3.4 7.8 0 11.2M8 2.4c3.4 3.4 3.4 7.8 0 11.2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
      />
    </svg>
  ),
  'did:btco': (
    // bitcoin
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M6 3.2h3.1a2 2 0 0 1 .5 3.9A2.1 2.1 0 0 1 9.2 11H6V3.2Zm0 3.9h3M7 2v1.2M7 11v1.3M9 2v1.2M9 11v1.3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  )
};

/**
 * The lifecycle pipeline: three layer nodes on a track.
 * `active` = index of the current layer (-1 for none), `autoplay` loops the
 * progression for the hero visual.
 */
export function Pipeline({
  active = -1,
  autoplay = false,
  busy = false
}: {
  active?: number;
  autoplay?: boolean;
  busy?: boolean;
}) {
  const [autoActive, setAutoActive] = useState(0);

  useEffect(() => {
    if (!autoplay) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setAutoActive(2);
      return;
    }
    const id = setInterval(() => {
      setAutoActive((current) => (current + 1) % 4); // 3 = brief "reset" beat
    }, 2400);
    return () => clearInterval(id);
  }, [autoplay]);

  const current = autoplay ? Math.min(autoActive, 2) : active;
  const resetting = autoplay && autoActive === 3;
  const fillPct = current <= 0 ? 0 : current === 1 ? 50 : 100;

  return (
    <div className="pipeline" data-resetting={resetting || undefined}>
      <div className="pipeline-track" aria-hidden="true">
        <div
          className="pipeline-fill"
          style={{ width: `${resetting ? 0 : fillPct}%` }}
        />
      </div>
      <ol className="pipeline-nodes">
        {layers.map((layer, i) => {
          const state = resetting
            ? 'idle'
            : i < current
              ? 'done'
              : i === current
                ? busy
                  ? 'busy'
                  : 'active'
                : 'idle';
          return (
            <li key={layer.id} className="pipeline-node" data-layer={layer.id} data-state={state}>
              <span className="pipeline-dot">{glyphs[layer.id]}</span>
              <span className="pipeline-name">{layer.name}</span>
              <span className="pipeline-role">{layer.role}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
