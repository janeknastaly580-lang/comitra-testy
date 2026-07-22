import { useState } from 'react';

/**
 * A clean, shareable link card with Copy + branded WhatsApp / Messenger buttons.
 * Used to send the judge invite and the recipient invite. No money, ever.
 */
export default function ShareLink({
  title,
  hint,
  link,
  phone,
}: {
  title: string;
  hint: string;
  link: string;
  /** Optional phone to pre-fill the WhatsApp deep link. */
  phone?: string;
}) {
  const [copied, setCopied] = useState(false);
  const [msgHint, setMsgHint] = useState(false);

  const slash = link.lastIndexOf('/');
  const linkHead = slash >= 0 ? link.slice(0, slash + 1) : link;
  const linkToken = slash >= 0 ? link.slice(slash + 1) : '';

  function copy() {
    navigator.clipboard?.writeText(link).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
      },
      () => setCopied(false),
    );
  }

  function shareWhatsApp() {
    const digits = (phone ?? '').replace(/\D/g, '');
    const target = digits ? `https://wa.me/${digits}` : 'https://wa.me/';
    window.open(`${target}?text=${encodeURIComponent(link)}`, '_blank', 'noopener');
  }

  function shareMessenger() {
    // Messenger has no universal "share arbitrary text" link like wa.me (that
    // needs a registered Facebook app id). The reliable behaviour is: copy the
    // link, then open Messenger so the user can paste it.
    navigator.clipboard?.writeText(link).catch(() => {});
    setMsgHint(true);
    setTimeout(() => setMsgHint(false), 3000);

    const ua = navigator.userAgent || '';
    const web = 'https://www.messenger.com/';

    if (/Android/i.test(ua)) {
      // In the Android app (Capacitor WebView) `window.open('fb-messenger://')`
      // is blocked. An Android `intent:` URL launches the Messenger app for real,
      // and falls back to the web if it isn't installed.
      window.location.href =
        `intent://#Intent;package=com.facebook.orca;S.browser_fallback_url=${encodeURIComponent(web)};end`;
      return;
    }
    if (/iPhone|iPad|iPod/i.test(ua)) {
      // iOS: try the app scheme, fall back to the web shortly after.
      window.location.href = 'fb-messenger://';
      setTimeout(() => { window.location.href = web; }, 800);
      return;
    }
    // Desktop: open Messenger for the web.
    window.open(web, '_blank', 'noopener');
  }

  return (
    <div className="rounded-2xl border border-line/60 bg-surface p-4 shadow-[0_1px_2px_rgba(16,24,40,0.04),0_12px_28px_-16px_rgba(16,24,40,0.14)]">
      <div className="mb-1 flex items-center justify-between">
        <span className="font-mono text-xs font-semibold uppercase tracking-widest text-ink">{title}</span>
        <button
          onClick={copy}
          className="inline-flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-xs font-medium text-muted transition hover:border-accent hover:text-accent"
        >
          {copied ? 'Copied ✓' : 'Copy link'}
        </button>
      </div>

      <p className="mb-3 text-sm text-muted">{hint}</p>

      <div className="mb-3 flex items-center gap-2 overflow-hidden rounded-xl border border-line bg-elevated px-3 py-3">
        <p className="truncate font-mono text-[13px] text-ink [overflow-wrap:anywhere]">
          {linkHead}
          <span className="font-semibold text-accent">{linkToken}</span>
        </p>
      </div>

      <div className="grid grid-cols-2 gap-2.5">
        <button
          onClick={shareWhatsApp}
          className="inline-flex items-center justify-center gap-2 rounded-xl bg-[#25D366] px-3 py-3 text-sm font-semibold text-white transition hover:brightness-110 active:brightness-95"
        >
          WhatsApp
        </button>
        <button
          onClick={shareMessenger}
          className="inline-flex items-center justify-center gap-2 rounded-xl bg-[#0084FF] px-3 py-3 text-sm font-semibold text-white transition hover:brightness-110 active:brightness-95"
        >
          Messenger
        </button>
      </div>

      {msgHint && (
        <p className="mt-2 text-center text-[11px] text-muted">
          Link copied — paste it into your Messenger chat.
        </p>
      )}
    </div>
  );
}
