/**
 * Pactista brand mark: the "P" with a check folded into it.
 *
 * It is a capital P drawn as a folded ribbon — the wedge under the bowl is the
 * fold — with a check tucked into the corner the stem and bowl leave open. The
 * check is deliberately small: it is a mark inside the letter, not a tick sitting
 * beside one, and at 24px anything bigger stops reading as a P at all.
 *
 * THE VIEWBOX IS THE LETTER'S OWN BOX, and that is load-bearing. It runs from the
 * cap line (y=0) to the BASELINE (y=45) with no padding, because an SVG with no
 * text in it reports its bottom edge as its baseline — so cropping it here is
 * what lets `Wordmark` sit "actista" on the same line as the P with plain
 * `items-baseline`, instead of guessing at a nudge that only holds at one size.
 * Any change to the shape has to keep the lowest ink at y=45.
 *
 * WHY IT IS DRAWN RATHER THAN LINKED. This renders at every size from a 24px
 * header to a 36px sign-in screen, on light and dark themes, inside a WebView
 * that is usually offline. A path costs nothing, never 404s, and takes the
 * theme's accent with it — which is why the green is `fill-accent` and not a
 * literal: a premium theme changes the accent, and the mark follows.
 *
 * The fold is flat black at low opacity rather than a second, darker green: one
 * shape then darkens whatever accent it happens to sit on, instead of hard-coding
 * a shade that only works for the default green.
 */
export default function BrandMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 30 45" className={className} fill="none" aria-hidden="true">
      {/* The P itself. `evenodd` is what cuts the counter out of the bowl. */}
      <path
        d="M0 0 H17.5 C23.9 0 28 4.6 28 11 C28 17.4 23.9 22 17.5 22 H9.5 V45 L0 40.5 Z
           M9.5 7.5 V14.5 H17 C19.2 14.5 20.6 13.1 20.6 11 C20.6 8.9 19.2 7.5 17 7.5 Z"
        fillRule="evenodd"
        className="fill-accent"
      />
      {/* The fold, where the bowl turns back behind the stem. */}
      <path d="M9.5 22 H15 L9.5 27.5 Z" fill="#000" fillOpacity="0.22" />
      {/* The check. Mitred, butt-ended: the same flat facets as the letter. */}
      <path
        d="M12.5 29 L17.5 35 L27.5 23"
        className="stroke-accent"
        strokeWidth="5"
        strokeLinecap="butt"
        strokeLinejoin="miter"
      />
    </svg>
  );
}
