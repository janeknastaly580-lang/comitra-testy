/**
 * Comitra brand mark — the tilted "C" (accent green) with a check striking
 * through it. The check uses `ink` so it reads near-black on the light default
 * theme (matching the logo) while staying visible on dark premium themes.
 */
export default function BrandMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M16.5 6.7A7 7 0 1 0 16.5 17.3" className="stroke-accent" strokeWidth="3" />
      <path d="M8 12.4l3 3.4 7.4-8.9" className="stroke-ink" strokeWidth="2.6" />
    </svg>
  );
}
