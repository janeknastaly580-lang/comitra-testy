import { useEffect, useState } from 'react';
import { useApp } from '../context/AppContext';
import * as api from '../lib/api';
import { judgeInviteLink } from '../lib/share';
import type { SyncHealth } from '../lib/supabase';
import type { InvitedJudge } from '../lib/types';
import PageHeader from '../components/PageHeader';
import ShareLink from '../components/ShareLink';
import { Card } from '../components/ui';

/**
 * Whether a friend on another phone can actually complete the invite. Shown
 * before the link is sent, because the failure otherwise happens on someone
 * else's device where the owner never sees it.
 */
const HEALTH: Record<SyncHealth, { label: string; note: string; tone: string }> = {
  ok: {
    label: 'Sync · on',
    note: 'Friends can join from their own phone and will show up here.',
    tone: 'text-accent',
  },
  setup: {
    label: 'Sync · not ready',
    note: "The server isn't set up yet, so friends can't finish the invite. Sending the link now won't work.",
    tone: 'text-danger',
  },
  unreachable: {
    label: 'Sync · offline',
    note: "This device is offline, so the server can't be checked. Friends may not be able to finish the invite.",
    tone: 'text-warn',
  },
  'no-server': {
    label: 'Sync · no server',
    note:
      "The address Comitra is configured with doesn't answer, so nobody can finish an invite. " +
      'The Supabase project has to be restored or recreated, and VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY pointed at it.',
    tone: 'text-danger',
  },
  off: {
    label: 'Sync · this device only',
    note: 'No server is configured, so a friend can only join from this same browser.',
    tone: 'text-muted',
  },
};

export default function InviteFriends() {
  const { user } = useApp();
  const [token, setToken] = useState('');
  const [friends, setFriends] = useState<InvitedJudge[] | null>(null);
  const [health, setHealth] = useState<SyncHealth | null>(null);
  // Whether a friend will be asked to confirm their address with an emailed code.
  const [codeOn, setCodeOn] = useState<boolean | null>(null);

  useEffect(() => {
    if (!user) return;
    void (async () => {
      try {
        const invite = await api.getOrCreateJudgeInvite(user.id);
        setToken(invite.inviteToken);
        setFriends(await api.listInvitedJudges(user.id));
        setHealth(await api.getJudgeSyncHealth());
        setCodeOn(await api.judgeEmailVerificationAvailable());
      } catch (err) {
        // Without this the whole panel would sit blank on any failure, with
        // only an unhandled rejection to explain it. `offline` is the honest
        // report: we could not read the state of the shared store.
        console.error('[invite-friends] could not load invite state:', err);
        setHealth(navigator.onLine ? 'no-server' : 'unreachable');
        setFriends([]);
        setCodeOn(false);
      }
    })();
  }, [user]);

  if (!user) return null;

  return (
    <div className="px-4 py-5">
      <PageHeader title="Invite friends" subtitle="Add people who can judge your goals" back />

      <p className="mb-4 text-[13px] text-muted">
        Send this link to a friend. On <span className="font-semibold text-ink">their own device</span> they'll
        pick a name, give an email address, set a judge password, and agree to receive goal messages from
        Comitra. Once they've done that, you can pick them as a judge when you set a goal.
      </p>

      {health && (
        <div className="mb-4 rounded-xl border border-line bg-elevated px-3.5 py-2.5">
          <p className={`font-mono text-[10px] uppercase tracking-widest ${HEALTH[health].tone}`}>
            {HEALTH[health].label}
          </p>
          <p className="mt-1 text-[12px] text-muted">{HEALTH[health].note}</p>
        </div>
      )}

      {codeOn !== null && (
        <div className="mb-4 rounded-xl border border-line bg-elevated px-3.5 py-2.5">
          <p className={`font-mono text-[10px] uppercase tracking-widest ${codeOn ? 'text-accent' : 'text-warn'}`}>
            {codeOn ? 'Email check · on' : 'Email check · off'}
          </p>
          <p className="mt-1 text-[12px] text-muted">
            {codeOn
              ? 'Your friend gets a 6-digit code by email and has to enter it, so the address is proven to be theirs.'
              : 'Email verification is not switched on yet, so a friend can register any address without proving it. See SES_SETUP.md.'}
          </p>
        </div>
      )}

      {token && (
        <ShareLink
          title="Your invite link"
          hint="Anyone with this link can register as one of your judges, but only from a different device than this one."
          link={judgeInviteLink(token)}
        />
      )}

      <h2 className="mb-2 mt-6 font-mono text-xs uppercase tracking-widest text-muted">
        Your judges {friends && `· ${friends.length}`}
      </h2>
      {friends === null ? (
        <p className="py-6 text-center text-sm text-muted">Loading…</p>
      ) : friends.length === 0 ? (
        <Card className="p-6 text-center">
          <p className="text-sm text-muted">No one has joined yet. Share your link above.</p>
        </Card>
      ) : (
        <div className="space-y-2">
          {friends.map((f) => (
            <Card key={f.id} className="flex items-center justify-between p-3.5">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-ink">{f.name}</p>
                <p className="truncate font-mono text-[11px] text-muted">{f.email}</p>
              </div>
              <span className="font-mono text-[10px] uppercase tracking-widest text-accent">Ready</span>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
