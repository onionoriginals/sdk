/** Keeps a headline's last word on the same line as its full stop, so the stop never wraps alone. */
export function KeepLastWord({ text }: { text: string }) {
  const cut = text.lastIndexOf(' ');
  if (cut < 0) return <span className="nowrap">{text}</span>;
  return <>{text.slice(0, cut + 1)}<span className="nowrap">{text.slice(cut + 1)}</span></>;
}
