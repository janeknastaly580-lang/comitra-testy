import { useEffect, useState, type ReactNode } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import * as api from '../lib/api';
import { recipientInviteMessage } from '../lib/messages';
import type { RecipientConsent } from '../lib/types';
import { Badge, Button, Card, Label, Textarea } from '../components/ui';
import BrandMark from '../components/BrandMark';

export default function Recipient() {
  const routeParams = useParams();
  const [params] = useSearchParams();
  const token = routeParams.token ?? params.get('token') ?? '';

  const [state, setState] = useState<'loading' | 'not-found' | 'ready'>('loading');
  const [consent, setConsent] = useState<RecipientConsent | null>(null);
  const [ownerName, setOwnerName] = useState('');
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [reportText, setReportText] = useState('');
  const [reported, setReported] = useState(false);

  async function refresh() {
    if (!token) return setState('not-found');
    const res = await api.getConsentByToken(token);
    if (!res) return setState('not-found');
    setConsent(res.consent);
    setOwnerName(res.ownerName);
    setState('ready');
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const Shell = ({ children }: { children: ReactNode }) => (
    <div className="phone-scroll flex h-full flex-col overflow-y-auto px-5 pb-8 pt-10">
      <div className="mb-6 flex items-center gap-2">
        <BrandMark className="h-7 w-7" />
        <span className="font-mono text-sm font-bold tracking-[0.2em]">Comitra</span>
        <span className="ml-auto font-mono text-[10px] uppercase tracking-widest text-muted">Notifications</span>
      </div>
      {children}
    </div>
  );

  if (state === 'loading') {
    return (
      <Shell>
        <p className="text-sm text-muted">Loading…</p>
      </Shell>
    );
  }
  if (state === 'not-found' || !consent) {
    return (
      <Shell>
        <Card className="p-6 text-center">
          <p className="text-sm text-danger">This invite link is not valid.</p>
          <Link to="/login" className="mt-3 inline-block text-sm text-accent hover:underline">
            Go to Comitra
          </Link>
        </Card>
      </Shell>
    );
  }

  async function accept() {
    setBusy(true);
    try {
      setConsent(await api.acceptRecipientConsent(token));
    } finally {
      setBusy(false);
    }
  }

  async function revoke() {
    setBusy(true);
    try {
      setConsent(await api.revokeRecipientConsent(token));
    } finally {
      setBusy(false);
    }
  }

  async function submitReport() {
    setBusy(true);
    try {
      await api.reportAbuse({
        reporterRole: 'recipient',
        reporterContact: consent!.recipientContact,
        ownerUserId: consent!.ownerUserId,
        consentId: consent!.id,
        reason: reportText,
      });
      setReported(true);
      setReportOpen(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Shell>
      {consent.consentStatus === 'revoked' ? (
        <Card className="p-6 text-center">
          <Badge tone="neutral">Unsubscribed</Badge>
          <p className="mt-3 text-sm text-ink">
            You will no longer receive notifications about this user's goals.
          </p>
        </Card>
      ) : consent.consentStatus === 'accepted' ? (
        <>
          <Card className="p-5">
            <Badge tone="accent">You're accepting notifications</Badge>
            <p className="mt-3 text-sm text-ink">
              You agreed to receive notifications about the result of {ownerName}'s goals.
              You can stop at any time.
            </p>
            <p className="mt-2 text-[11px] text-muted">
              You'll only ever be messaged if one of their goals is marked not completed —
              never marketing.
            </p>
            <Button variant="outline" className="mt-4 w-full" disabled={busy} onClick={revoke}>
              I don't want to receive messages anymore
            </Button>
          </Card>
        </>
      ) : (
        <>
          <Card className="p-5">
            <Label>Invitation</Label>
            <p className="mb-4 text-sm text-ink">{recipientInviteMessage(ownerName)}</p>
            <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-line p-3">
              <input
                type="checkbox"
                checked={ack}
                onChange={(e) => setAck(e.target.checked)}
                className="mt-0.5 h-4 w-4 accent-[color:rgb(var(--c-accent))]"
              />
              <span className="text-[12px] leading-relaxed text-ink">
                I agree to receive notifications about the result of this user's goals. I know
                I can withdraw my consent at any time.
              </span>
            </label>
            <div className="mt-3 grid grid-cols-2 gap-3">
              <Button variant="outline" disabled={busy} onClick={revoke}>
                No thanks
              </Button>
              <Button disabled={busy || !ack} onClick={accept}>
                Accept
              </Button>
            </div>
          </Card>
        </>
      )}

      {/* Report abuse */}
      <div className="mt-6 border-t border-line pt-4">
        {reported ? (
          <p className="text-center text-[12px] text-muted">Thanks — your report was recorded.</p>
        ) : reportOpen ? (
          <Card className="p-4">
            <Label>Report abuse</Label>
            <Textarea rows={3} value={reportText} onChange={(e) => setReportText(e.target.value)} placeholder="Tell us what's wrong" />
            <div className="mt-2 grid grid-cols-2 gap-2">
              <Button variant="outline" onClick={() => setReportOpen(false)}>Cancel</Button>
              <Button disabled={busy || reportText.trim().length < 5} onClick={submitReport}>Send report</Button>
            </div>
          </Card>
        ) : (
          <button onClick={() => setReportOpen(true)} className="w-full text-center text-[11px] text-muted hover:text-danger">
            Report abuse
          </button>
        )}
      </div>
    </Shell>
  );
}
