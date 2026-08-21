import { useMemo } from 'react';
import { qrPath } from '../sdk/qr-path';

/**
 * The deposit address as a scannable BIP-21 code.
 *
 * Rendered as inline SVG rather than a canvas or an image so it stays crisp at
 * any size, needs no ref or effect, and carries no external request.
 *
 * Error correction is 'M'. 'L' would be denser but this code is pointed at by
 * a phone camera, often at a screen with glare, and a misread is a payment to
 * nowhere — though in practice a corrupted bech32 address fails its checksum
 * in the wallet rather than sending anywhere.
 */
export function DepositQr({ value, size = 168 }: { value: string; size?: number }) {
  const { path, count } = useMemo(() => qrPath(value), [value]);

  // The quiet zone is part of the spec, not padding: scanners need it to find
  // the code at all. Four modules on each side, inside the viewBox.
  const quiet = 4;
  const extent = count + quiet * 2;

  return (
    <svg
      className="deposit-qr"
      viewBox={`0 0 ${extent} ${extent}`}
      width={size}
      height={size}
      role="img"
      aria-label="Scan to pay this deposit address"
      shapeRendering="crispEdges"
    >
      <rect width={extent} height={extent} fill="#ffffff" />
      <g transform={`translate(${quiet} ${quiet})`} fill="#08090c">
        <path d={path} />
      </g>
    </svg>
  );
}
