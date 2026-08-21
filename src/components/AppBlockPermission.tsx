import { useEffect, useState } from 'react';
import { getAppBlockStatus, openAppBlockSettings, type AppBlockStatus } from '../lib/appBlock';
import { Button, Card } from './ui';

/**
 * Shown when a goal has a block but Android isn't enforcing it yet.
 *
 * Blocking needs an accessibility service the user must switch on by hand,
 * Android will not let an app grant it to itself. Until that happens the block
 * is stored but toothless, and saying nothing would let someone believe an app
 * is blocked while they can still open it.
 *
 * Renders nothing on the web, or once the permission is granted.
 */
export default function AppBlockPermission({ appLabel }: { appLabel?: string }) {
  const [status, setStatus] = useState<AppBlockStatus | null>(null);

  async function refresh() {
    setStatus(await getAppBlockStatus());
  }

  useEffect(() => {
    refresh();
    // Coming back from the settings screen should clear this card, so re-check
    // whenever the app returns to the foreground.
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  if (!status || !status.supported || status.permissionGranted) return null;

  return (
    <Card className="mb-4 border-warn/50 bg-warn/5 p-4">
      <p className="font-mono text-[10px] uppercase tracking-widest text-warn">Blocking is not active yet</p>
      <p className="mt-1 text-[12px] leading-relaxed text-ink">
        {appLabel ? `${appLabel} is set to be blocked` : 'Your block is set'}, but Android has to allow it.
        Turn on <span className="font-semibold">Pactista app blocking</span> under Accessibility.
      </p>
      <Button className="mt-3 w-full" onClick={openAppBlockSettings}>
        Open Android settings
      </Button>
    </Card>
  );
}
