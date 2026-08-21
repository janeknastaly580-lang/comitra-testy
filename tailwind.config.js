/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      // Colors are driven by CSS variables (see src/index.css) so premium themes
      // can be swapped at runtime by toggling [data-theme] on the root element.
      colors: {
        bg: 'rgb(var(--c-bg) / <alpha-value>)',
        surface: 'rgb(var(--c-surface) / <alpha-value>)',
        elevated: 'rgb(var(--c-elevated) / <alpha-value>)',
        line: 'rgb(var(--c-line) / <alpha-value>)',
        accent: 'rgb(var(--c-accent) / <alpha-value>)',
        'on-accent': 'rgb(var(--c-on-accent) / <alpha-value>)',
        active: 'rgb(var(--c-active) / <alpha-value>)',
        danger: 'rgb(var(--c-danger) / <alpha-value>)',
        warn: 'rgb(var(--c-warn) / <alpha-value>)',
        ink: 'rgb(var(--c-ink) / <alpha-value>)',
        muted: 'rgb(var(--c-muted) / <alpha-value>)',
      },
      fontFamily: {
        sans: ['"DM Sans"', 'system-ui', 'sans-serif'],
        // `font-mono` keeps its name and every one of its 175 call sites: what
        // those uses actually want is a technical LABEL and figures that line up
        // in a column, not typewriter letterforms. So it points at the same
        // family as `sans`, and `.font-mono` in index.css keeps the tabular
        // figures — the type changes shape, nothing changes place.
        mono: ['"DM Sans"', 'system-ui', 'sans-serif'],
        // The serif half of the wordmark. Nothing else uses it.
        brand: ['"Playfair Display"', 'Georgia', 'serif'],
      },
      borderRadius: {
        none: '0',
        sm: '2px',
        DEFAULT: '4px',
        md: '6px',
        lg: '8px',
      },
      boxShadow: {
        glow: '0 0 0 1px rgb(var(--c-accent) / 0.4), 0 0 18px -4px rgb(var(--c-accent) / 0.45)',
      },
    },
  },
  plugins: [],
};
