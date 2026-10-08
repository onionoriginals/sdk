/** The small lockup's mark: the ring with the diamond reduced to a dot. */
export function Mark() {
  return (
    <svg className="mark" viewBox="0 0 22 22" aria-hidden="true">
      <circle cx="10" cy="12" r="7.4" fill="none" stroke="currentColor" strokeWidth="2.2" />
      <circle cx="16.3" cy="5.7" r="3.3" fill="var(--accent)" />
    </svg>
  );
}
