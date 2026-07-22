import { useEffect, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import * as api from '../lib/api';
import { JUDGE_CODE_MIN } from '../lib/api';
import { DEFAULT_COUNTRY_ISO, fullPhone } from '../lib/countries';
import BrandMark from '../components/BrandMark';
import PhoneField from '../components/PhoneField';
import { Badge, Button, Card, Input, Label } from '../components/ui';

export default function InviteAccept() {
  const { token = '' } = useParams();
  const [state, setState] = useState<'loading' | 'not-found' | 'ready' | 'done'>('loading');
  const [ownerName, setOwnerName] = useState('');

  const [name, setName] = useState('');
  const [phoneIso, setPhoneIso] = useState(DEFAULT_COUNTRY_ISO);
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      if (!token) return setState('not-found');
      const res = await api.getJudgeInvite(token);
      if (!res) return setState('not-found');
      setOwnerName(res.ownerName);
      setState('ready');
    })();
  }, [token]);

  const Shell = ({ children }: { children: ReactNode }) => (
    <div className="phone-scroll flex h-full flex-col overflow-y-auto px-5 pb-8 pt-10">
      <div className="mb-6 flex items-center gap-2">
        <BrandMark className="h-7 w-7" />
        <span className="font-mono text-sm font-bold tracking-[0.2em]">Comitra</span>
        <span className="ml-auto font-mono text-[10px] uppercase tracking-widest text-muted">Judge invite</span>
      </div>
      {children}
    </div>
  );

  if (state === 'loading') return <Shell><p className="text-sm text-muted">Loading…</p></Shell>;

  if (state === 'not-found') {
    return (
      <Shell>
        <Card className="p-6 text-center">
          <p className="text-sm text-danger">This invite link is not valid.</p>
          <Link to="/login" className="mt-3 inline-block text-sm text-accent hover:underline">Go to Comitra</Link>
        </Card>
      </Shell>
    );
  }

  if (state === 'done') {
    return (
      <Shell>
        <Card className="p-6 text-center">
          <Badge tone="accent">You're set</Badge>
          <p className="mt-3 text-sm text-ink">
            {ownerName} can now pick you as a judge for their goals. Keep your secret code safe — you'll
            need it to mark a goal completed or not completed.
          </p>
        </Card>
      </Shell>
    );
  }

  const phoneValid = phone.replace(/\D/g, '').length >= 7;
  const canSubmit = name.trim().length >= 2 && phoneValid && code.trim().length >= JUDGE_CODE_MIN && consent;

  async function submit() {
    setError('');
    setBusy(true);
    try {
      await api.submitJudgeInvite(token, { name, phone: fullPhone(phoneIso, phone), code });
      setState('done');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Shell>
      <h1 className="mb-1 text-xl font-bold text-ink">{ownerName} invited you</h1>
      <p className="mb-4 text-sm text-muted">
        {ownerName} wants to be able to choose you as the judge of their goals — the person who confirms
        whether they did what they set out to do.
      </p>

      <Card className="p-4">
        <Label>Your name</Label>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" className="mb-3" />

        <Label>Your phone number</Label>
        <div className="mb-3">
          <PhoneField iso={phoneIso} number={phone} onIso={setPhoneIso} onNumber={setPhone} />
        </div>

        <Label>Set your secret code</Label>
        <Input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder={`At least ${JUDGE_CODE_MIN} characters`}
          autoComplete="off"
        />
        <p className="mt-1.5 text-[11px] text-muted">
          Keep this code secret. Every time {ownerName} picks you as a judge, you'll enter it to mark
          their goal completed or not completed. This code is just for {ownerName}'s goals — you can use
          a different one with other people. (You can always cancel a goal at their request without any code.)
        </p>

        <label className="mt-3 flex cursor-pointer items-start gap-2 rounded-lg border border-line p-3">
          <input
            type="checkbox"
            checked={consent}
            onChange={(e) => setConsent(e.target.checked)}
            className="mt-0.5 h-4 w-4 accent-[color:rgb(var(--c-accent))]"
          />
          <span className="text-[12px] leading-relaxed text-ink">
            I agree to receive messages from Comitra. These are only about {ownerName}'s goals (for example,
            asking me to decide one) — never marketing.
          </span>
        </label>

        {error && <p className="mt-3 font-mono text-xs text-danger">{error}</p>}
        <Button className="mt-3 w-full" disabled={busy || !canSubmit} onClick={submit}>
          {busy ? 'Saving…' : 'Become a judge'}
        </Button>
      </Card>
    </Shell>
  );
}
