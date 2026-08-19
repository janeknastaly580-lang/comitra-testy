import { useEffect, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import * as api from '../lib/api';
import { JUDGE_CODE_MIN } from '../lib/api';
import { SyncError } from '../lib/supabase';
import BrandMark from '../components/BrandMark';
import CodeVerify from '../components/CodeVerify';
import { Badge, Button, Card, Input, Label } from '../components/ui';
import { Check } from 'lucide-react';

/**
 * Page chrome. IMPORTANT: this lives at module scope, NOT inside InviteAccept.
 * When it was defined inside the component it became a brand-new function on every
 * render, so each keystroke made React remount the whole subtree and the inputs
 * lost focus: on mobile the keyboard closed after every character, on desktop the
 * caret dropped out of the field. A stable component identity keeps focus.
 */
function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="phone-scroll flex h-full flex-col overflow-y-auto px-5 pb-8 pt-10">
      <div className="mb-6 flex items-center gap-2">
        <BrandMark className="h-7 w-7" />
        <span className="font-mono text-sm font-bold tracking-[0.2em]">Comitra</span>
        <span className="ml-auto font-mono text-[10px] uppercase tracking-widest text-muted">Judge invite</span>
      </div>
      {children}
    </div>
  );
}

export default function InviteAccept() {
  const { token = '' } = useParams();
  const [state, setState] = useState<
    'loading' | 'unreadable' | 'same-device' | 'same-account' | 'ready' | 'verify' | 'done'
  >('loading');
  const [ownerName, setOwnerName] = useState('');

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // A server-setup failure is not the judge's to retry, it needs the inviter to
  // finish Comitra's one-time setup, so the button is labelled differently.
  const [errorIsSetup, setErrorIsSetup] = useState(false);

  // Whether this project confirms a judge's address with an emailed code.
  // `null` = not probed yet; the answer only changes the button label.
  const [codeRequired, setCodeRequired] = useState<boolean | null>(null);

  // Verification step state (the code itself lives inside <CodeVerify/>).
  const [otpError, setOtpError] = useState('');
  const [emailVerified, setEmailVerified] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const res = await api.getJudgeInvite(token);
        setOwnerName(res.ownerName);
        // The person being judged must not register as their own judge,
        // block (with a reason) when it's the same device or the same account.
        if (!res.ok) {
          if (res.reason === 'same-device') return setState('same-device');
          if (res.reason === 'same-account') return setState('same-account');
          return setState('unreadable');
        }
        setState('ready');
        // Probe whether a code is required (best-effort; falls back to false).
        api.judgeEmailVerificationAvailable().then(setCodeRequired).catch(() => setCodeRequired(false));
      } catch (err) {
        // Anything thrown here used to leave the page on "Loading…" forever.
        // `unreadable` already explains a broken/expired link, which is by far
        // the likeliest cause and tells the judge what to ask their friend for.
        console.error('[invite-accept] could not read the invite:', err);
        setState('unreadable');
      }
    })();
  }, [token]);

  if (state === 'loading') return <Shell><p className="text-sm text-muted">Loading…</p></Shell>;

  if (state === 'unreadable') {
    return (
      <Shell>
        <Card className="p-6">
          <Badge tone="warn">Link couldn't be opened</Badge>
          <p className="mt-3 text-sm text-ink">
            We couldn't read this invite. It didn't work because one of these happened:
          </p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-[13px] text-muted">
            <li>the link was <span className="font-semibold text-ink">cut off</span> when it was sent (long links can break in chat apps), or</li>
            <li>it's an <span className="font-semibold text-ink">old link</span> from a previous version of the app.</li>
          </ul>
          <p className="mt-3 text-[13px] text-ink">
            Ask your friend to open <span className="font-semibold">Profile &gt; Invite friends</span> again and
            send you the <span className="font-semibold">newest</span> link (best via “Copy link”, so nothing
            gets cut off).
          </p>
          <Link to="/login" className="mt-4 inline-block text-sm text-accent hover:underline">Go to Comitra</Link>
        </Card>
      </Shell>
    );
  }

  if (state === 'same-device') {
    return (
      <Shell>
        <Card className="p-6">
          <Badge tone="danger">Same device, can't continue here</Badge>
          <p className="mt-3 text-sm text-ink">
            Nobody can be their own judge, and this invite was made on this device.
          </p>
          <p className="mt-2 text-[13px] text-muted">
            Open the link on the judge's own <span className="font-semibold text-ink">phone or computer</span>.
          </p>
          <Link to="/login" className="mt-4 inline-block text-sm text-accent hover:underline">Go to Comitra</Link>
        </Card>
      </Shell>
    );
  }

  if (state === 'same-account') {
    return (
      <Shell>
        <Card className="p-6">
          <Badge tone="danger">Same account, can't continue here</Badge>
          <p className="mt-3 text-sm text-ink">
            You're signed in as <span className="font-semibold">{ownerName || 'the person who created this invite'}</span>,
            and a judge has to be someone else.
          </p>
          <p className="mt-2 text-[13px] text-muted">
            Ask your judge to open the link on{' '}
            <span className="font-semibold text-ink">their own device</span>, or while logged out.
          </p>
          <Link to="/login" className="mt-4 inline-block text-sm text-accent hover:underline">Go to Comitra</Link>
        </Card>
      </Shell>
    );
  }

  if (state === 'done') {
    return (
      <Shell>
        <Card className="p-6 text-center">
          <Badge tone="accent">You're set</Badge>
          {emailVerified && (
            <p className="mt-3 font-mono text-[10px] uppercase tracking-widest text-accent"><Check className="mr-1 inline h-3 w-3" aria-hidden /> Email address verified</p>
          )}
          <p className="mt-3 text-sm text-ink">
            {ownerName} can now pick you as a judge. Keep your judge password safe — you need it every time.
          </p>
        </Card>
      </Shell>
    );
  }

  const emailValid = api.emailLooksValid(email);
  const canSubmit = name.trim().length >= 2 && emailValid && code.trim().length >= JUDGE_CODE_MIN && consent;

  /** Register the judge (recording whether they passed the code check). */
  async function finishRegistration(verified: boolean) {
    await api.submitJudgeInvite(token, { name, email, code, emailVerified: verified });
    setEmailVerified(verified);
    setState('done');
  }

  /** Turn a thrown error into the on-screen message + "is this a setup problem?" flag. */
  function showError(err: unknown, set: (m: string) => void) {
    set((err as Error).message);
    setErrorIsSetup(err instanceof SyncError && err.kind === 'setup');
  }

  // Primary button on the details form: either email a code first, or (where the
  // backend cannot send email at all) register straight away.
  async function onPrimary() {
    setError('');
    setErrorIsSetup(false);
    setBusy(true);
    try {
      // Resolve availability now if the background probe hasn't answered yet, so a
      // fast tapper never slips past the code gate on a project that requires it.
      const needsCode = codeRequired ?? (await api.judgeEmailVerificationAvailable());
      setCodeRequired(needsCode);
      if (needsCode) {
        await api.startEmailVerification(email, 'judge');
        setOtpError('');
        setState('verify');
      } else {
        await finishRegistration(false);
      }
    } catch (err) {
      showError(err, setError);
    } finally {
      setBusy(false);
    }
  }

  async function onResend(): Promise<boolean> {
    setOtpError('');
    setBusy(true);
    try {
      await api.startEmailVerification(email, 'judge');
      return true;
    } catch (err) {
      showError(err, setOtpError);
      return false;
    } finally {
      setBusy(false);
    }
  }

  // On the verify step: check the emailed code, then finish registration.
  async function onVerify(code: string) {
    setOtpError('');
    setErrorIsSetup(false);
    setBusy(true);
    try {
      await api.verifyEmailCode(email, code, 'judge');
      await finishRegistration(true);
    } catch (err) {
      showError(err, setOtpError);
    } finally {
      setBusy(false);
    }
  }

  if (state === 'verify') {
    return (
      <Shell>
        <h1 className="mb-1 text-xl font-bold text-ink">Confirm your email</h1>
        <p className="mb-4 text-sm text-muted">
          Enter the code below to prove this address is yours.
        </p>

        <Card className="p-4">
          <CodeVerify
            destination={email}
            busy={busy}
            error={otpError}
            errorIsSetup={errorIsSetup}
            submitLabel="Verify & become a judge"
            onVerify={onVerify}
            onResend={onResend}
            onBack={() => {
              setState('ready');
              setOtpError('');
            }}
          />
        </Card>
      </Shell>
    );
  }

  return (
    <Shell>
      <h1 className="mb-1 text-xl font-bold text-ink">{ownerName} invited you</h1>
      <p className="mb-4 text-sm text-muted">
        {ownerName} wants you as the judge of their goals — the person who confirms they did it.
      </p>

      <Card className="p-4">
        <Label>Your name</Label>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" />
        <p className="mb-3 mt-1.5 text-[11px] text-muted">
          A name {ownerName} will recognise, different from their other judges.
        </p>

        <Label>Your email address</Label>
        <Input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@email.com"
          autoComplete="email"
          inputMode="email"
        />
        {codeRequired ? (
          <p className="mb-3 mt-1.5 text-[11px] text-muted">
            We'll email a 6-digit code to confirm it's yours.
          </p>
        ) : (
          <div className="mb-3" />
        )}

        <Label>Set your judge password</Label>
        <Input
          type="password"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder={`At least ${JUDGE_CODE_MIN} characters`}
          autoComplete="new-password"
        />
        <p className="mt-1.5 text-[11px] font-semibold text-accent">
          Write it down somewhere safe. It can't be recovered.
        </p>
        <p className="mt-1 text-[11px] text-muted">
          You enter it every time you decide one of {ownerName}'s goals. It is only for theirs.
        </p>

        <label className="mt-3 flex cursor-pointer items-start gap-2 rounded-lg border border-line p-3">
          <input
            type="checkbox"
            checked={consent}
            onChange={(e) => setConsent(e.target.checked)}
            className="mt-0.5 h-4 w-4 accent-[color:rgb(var(--c-accent))]"
          />
          <span className="text-[12px] leading-relaxed text-ink">
            I agree to receive messages from Comitra about {ownerName}'s goals. Never marketing.
          </span>
        </label>

        {error && (
          <div className="mt-3 rounded-xl border border-danger/40 bg-danger/5 p-3">
            <p className="font-mono text-[10px] uppercase tracking-widest text-danger">
              {errorIsSetup ? "Server isn't ready" : "Couldn't save"}
            </p>
            <p className="mt-1.5 text-[13px] leading-relaxed text-ink">{error}</p>
            {errorIsSetup && (
              <p className="mt-1.5 text-[11px] text-muted">
                Nothing is lost — your details are on this device. Try the button again later.
              </p>
            )}
          </div>
        )}
        <Button className="mt-3 w-full" disabled={busy || !canSubmit} onClick={onPrimary}>
          {busy
            ? codeRequired
              ? 'Emailing code…'
              : 'Saving…'
            : error
              ? 'Try again'
              : codeRequired
                ? 'Send verification code'
                : codeRequired === null
                  ? 'Continue'
                  : 'Become a judge'}
        </Button>
      </Card>
    </Shell>
  );
}
