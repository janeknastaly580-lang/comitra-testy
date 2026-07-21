import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import * as api from '../lib/api';
import { SUBSCRIPTION_PRICE_MONTHLY, TRIAL_DAYS } from '../lib/constants';
import { usd } from '../lib/format';
import AuthModal from '../components/AuthModal';
import PageHeader from '../components/PageHeader';
import { Badge, Button, Card } from '../components/ui';

const FEATURES = [
  'Create and run goals',
  'Assign a judge to confirm your results',
  'Choose 1–3 people to be notified if you miss a goal',
  'Pick the message tone and preview it first',
  'Add proof (text, link or photo) for your judge',
];

export default function Subscription() {
  const { user, subscribe, cancelSubscription } = useApp();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);

  if (!user) return null;

  const s = user.subscription;
  const entitled = api.hasEntitlement(user);
  const trialing = s.status === 'trialing' && entitled;
  const daysLeft =
    trialing && s.trialEndsAt
      ? Math.max(0, Math.ceil((+new Date(s.trialEndsAt) - Date.now()) / (24 * 3600 * 1000)))
      : 0;

  async function activate() {
    // You must be logged in (a real account, not a guest) to buy a subscription.
    if (user!.isGuest) {
      setAuthOpen(true);
      return;
    }
    setBusy(true);
    await subscribe();
    setBusy(false);
    navigate('/goals');
  }

  async function cancel() {
    setBusy(true);
    await cancelSubscription();
    setBusy(false);
  }

  return (
    <div className="px-4 py-5">
      <PageHeader title="Subscription" subtitle="Manage your plan." back />

      <div className="mb-4 flex items-center justify-between">
        <span className="font-mono text-xs uppercase tracking-widest text-muted">Status</span>
        <Badge tone={s.status === 'active' ? 'active' : trialing ? 'accent' : 'warn'}>
          {s.status === 'active' ? 'Active' : trialing ? `Trial · ${daysLeft}d left` : s.status}
        </Badge>
      </div>

      {/* Plan card */}
      <Card className="mb-4 border-accent/30 p-5">
        <p className="font-mono text-[10px] uppercase tracking-widest text-muted">Comitra subscription</p>
        <p className="mt-1 font-mono text-3xl font-bold text-ink">
          {usd(SUBSCRIPTION_PRICE_MONTHLY)}
          <span className="text-sm text-muted">/mo</span>
        </p>
        <p className="mt-2 text-sm text-muted">
          {s.status === 'active'
            ? 'Your subscription is active.'
            : trialing
              ? `You're on a free trial with ${daysLeft} day(s) left. Subscribe to keep creating goals after it ends.`
              : 'Create goals, track your steps, and use social commitment for $4.99 a month.'}
        </p>
        {s.status !== 'active' && (
          <p className="mt-1 text-[11px] text-muted">
            Works for any personal goal — habits, projects, studying and weekly challenges.
          </p>
        )}

        <ul className="mt-3 space-y-1.5">
          {FEATURES.map((f) => (
            <li key={f} className="flex items-start gap-2 text-[12px] text-muted">
              <span className="mt-0.5 text-accent">✓</span>
              <span>{f}</span>
            </li>
          ))}
        </ul>
      </Card>

      {s.status === 'active' ? (
        <Button variant="outline" className="w-full" disabled={busy} onClick={cancel}>
          Cancel subscription
        </Button>
      ) : (
        <Button className="w-full" disabled={busy} onClick={activate}>
          {busy ? 'Activating…' : `Activate subscription — ${usd(SUBSCRIPTION_PRICE_MONTHLY)}/mo`}
        </Button>
      )}

      <p className="mb-4 mt-2 text-center text-[11px] text-muted">
        Payment is a placeholder in this build (ready to connect Stripe, RevenueCat, App Store or
        Google Play). The fee only unlocks app features.
      </p>

      <Card className="p-4">
        <p className="font-mono text-[10px] uppercase tracking-widest text-muted">Free trial</p>
        <p className="mt-1 text-[12px] text-muted">
          New accounts start with a {TRIAL_DAYS}-day free trial. Without an active subscription you
          can still log in, see your goals, finish an already-active goal, and manage your data.
        </p>
      </Card>

      <AuthModal
        open={authOpen}
        onClose={() => setAuthOpen(false)}
        title="Log in to subscribe"
        subtitle="You need to be logged in to have an account and buy a subscription."
      />
    </div>
  );
}
