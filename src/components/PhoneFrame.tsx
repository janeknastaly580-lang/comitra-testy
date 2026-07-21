import type { ReactNode } from 'react';

/**
 * Fixed smartphone-proportioned shell centered on the desktop viewport.
 * On a real device (Capacitor / React Native WebView) the outer chrome simply
 * fills the screen, so the inner layout is what ships — nothing here assumes a
 * desktop. The bezel is purely cosmetic for the localhost preview.
 */
export default function PhoneFrame({ children }: { children: ReactNode }) {
  return (
    <div className="lab-grid flex min-h-screen w-full items-center justify-center p-0 sm:p-6">
      <div className="relative h-[100dvh] w-full max-w-[420px] overflow-hidden border-line bg-bg sm:h-[860px] sm:rounded-[28px] sm:border-[10px] sm:border-black sm:shadow-[0_18px_50px_-12px_rgba(0,0,0,0.35)]">
        {/* Notch — cosmetic, hidden when running full-bleed on a phone. */}
        <div className="pointer-events-none absolute left-1/2 top-0 z-30 hidden h-6 w-36 -translate-x-1/2 rounded-b-2xl bg-black sm:block" />
        <div className="flex h-full flex-col">{children}</div>
      </div>
    </div>
  );
}
