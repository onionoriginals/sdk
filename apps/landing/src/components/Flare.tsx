/** The diamond: a four-point star with a warm core, from the logo's flare. */
export function Flare({ className = '' }: { className?: string }) {
  return (
    <svg className={`flare ${className}`} viewBox="-50 -50 100 100" aria-hidden="true">
      <circle r="22" fill="#ff9a2e" fillOpacity=".35" />
      <circle r="12" fill="#ffbe6e" fillOpacity=".7" />
      <path d="M0 -46 L3 -3 L48 0 L3 3 L0 40 L-3 3 L-48 0 L-3 -3Z" fill="#fff" />
    </svg>
  );
}
