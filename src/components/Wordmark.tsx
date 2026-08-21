import BrandMark from './BrandMark';

/**
 * The full logo: the mark IS the P, and "actista" finishes the word.
 *
 * That is the whole idea behind it — the reader does not see a symbol beside a
 * name, they see one word whose first letter happens to be drawn. Two things
 * follow from that and are worth not undoing:
 *
 *   • the gap is negative, not a `gap-2`. A letter inside a word sits tight
 *     against the next one; anything that reads as a space breaks the word in
 *     half and turns the mark back into a logo-next-to-text.
 *   • the serif is only ever used here. Everything else in the app is DM Sans
 *     (see tailwind.config.js), so this stays the one place that looks like a
 *     name rather than an interface.
 *
 * Sizes are passed in rather than fixed, because the header wants this small and
 * a sign-in screen wants it large, and the two halves have to grow together.
 */
export default function Wordmark({
  markClass = 'h-6',
  textClass = 'text-xl',
  className = '',
}: {
  /** Height of the P. Width follows from the viewBox. */
  markClass?: string;
  /** Size of "actista". Roughly 3× the mark's height reads as one word. */
  textClass?: string;
  className?: string;
}) {
  return (
    <span className={`inline-flex items-baseline ${className}`}>
      {/* `items-baseline` puts the P on the same line as the letters that follow
          it, because BrandMark's viewBox ends exactly at the baseline — see the
          note in that file before changing either one. */}
      <BrandMark className={`${markClass} w-auto`} />
      <span className={`font-brand -ml-[0.04em] font-medium leading-none tracking-tight ${textClass}`}>
        actista
      </span>
    </span>
  );
}
