/**
 * The Mergeport mark: two branches merging into one stem that ends at a port. The tile follows the theme (ink on canvas
 * inverted), the strokes use `currentColor`. `pathLength={1}` lets the hover animation (`.mark-logo` in motion.css) draw
 * the branches without measuring them.
 */
export function Logo({ size = 32, className }: { size?: number; className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      width={size}
      height={size}
      aria-hidden
      className={`mark-logo shrink-0 rounded-[9px] bg-ink text-ink-invert ${className ?? ""}`}
      fill="none"
      stroke="currentColor"
      strokeWidth={2.4}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path className="mark-branch" pathLength={1} d="M9 8.5C9 15 16 14 16 20" />
      <path className="mark-branch" pathLength={1} d="M23 8.5C23 15 16 14 16 20" />
      <path d="M16 20V23" />
      <circle cx="9" cy="8.5" r="1.9" fill="currentColor" stroke="none" />
      <circle cx="23" cy="8.5" r="1.9" fill="currentColor" stroke="none" />
      <circle className="mark-port" cx="16" cy="25.5" r="2.3" fill="currentColor" stroke="none" />
    </svg>
  );
}
