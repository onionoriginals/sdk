import qrcode from 'qrcode-generator';

/**
 * Encode a string as QR modules, flattened into one SVG path.
 *
 * Separate from the component so it can be tested without React or a DOM —
 * this renders a payment address, so "does it encode what we think" is worth
 * asserting rather than assuming.
 *
 * One path, not a rect per module: a version-5 code is 1,369 cells, and the
 * deposit panel re-renders on every balance poll.
 */
export function qrPath(value: string): { path: string; count: number } {
  const qr = qrcode(0, 'M'); // 0 = smallest version that fits; M = ~15% recovery
  qr.addData(value);
  qr.make();
  const count = qr.getModuleCount();
  let path = '';
  for (let row = 0; row < count; row += 1) {
    for (let col = 0; col < count; col += 1) {
      if (qr.isDark(row, col)) path += `M${col} ${row}h1v1h-1z`;
    }
  }
  return { path, count };
}
