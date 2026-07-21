import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../context/AppContext';
import * as api from '../lib/api';
import {
  analyze,
  buildReport,
  formatSpan,
  WEEKDAYS,
  type Analysis,
  type HourBucket,
} from '../lib/analytics';
import type { Goal } from '../lib/types';
import PageHeader from '../components/PageHeader';
import PremiumGate from '../components/PremiumGate';
import { Badge, Button, Card, Label } from '../components/ui';

const DAY_INITIAL = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const pct = (r: number) => `${Math.round(r * 100)}%`;

export default function Analytics() {
  const { user } = useApp();
  const [goals, setGoals] = useState<Goal[]>([]);
  const [friendNames, setFriendNames] = useState<string[]>([]);
  const [exported, setExported] = useState(false);

  useEffect(() => {
    if (!user) return;
    api.listGoals(user.id).then(setGoals);
    api.listFriends(user.id).then((fr) => setFriendNames(fr.map((f) => f.name)));
  }, [user]);

  const a = useMemo(() => analyze(goals, friendNames), [goals, friendNames]);

  if (!user) return null;
  if (!user.isPremium) {
    return (
      <div className="px-4 py-5">
        <PageHeader title="Pro Analytics & Export" back />
        <PremiumGate
          title="Comitra Premium Analytics"
          blurb="Deterministic insight into your motivation peaks, willpower price, judges and vulnerable hours — plus a downloadable report. Premium feature."
        />
      </div>
    );
  }

  function exportReport() {
    const report = buildReport(user!.name, a);
    const blob = new Blob([report], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const el = document.createElement('a');
    el.href = url;
    el.download = `Comitra-Analytics-${new Date().toISOString().slice(0, 10)}.txt`;
    document.body.appendChild(el);
    el.click();
    el.remove();
    URL.revokeObjectURL(url);
    setExported(true);
    setTimeout(() => setExported(false), 2000);
  }

  const enoughData = a.resolved > 0;

  return (
    <div className="px-4 py-5">
      <PageHeader title="Pro Analytics & Export" subtitle="Comitra Premium · deterministic insight" back />

      {/* Overview */}
      <div className="mb-4 grid grid-cols-3 gap-2">
        <Mini label="Goals" value={String(a.totalGoals)} />
        <Mini label="Resolved" value={String(a.resolved)} />
        <Mini label="Completion" value={`${a.winRate}%`} tone="accent" />
      </div>

      {!enoughData && (
        <Card className="mb-4 border-warn/40 p-4">
          <p className="text-sm text-ink">
            Resolve a few challenges to populate your analytics. The sections below fill in
            automatically as your history grows — every figure is computed from your own data.
          </p>
        </Card>
      )}

      <MotivationCard a={a} />
      <SocialCard a={a} />
      <VulnerabilityCard a={a} />

      {/* Export */}
      <Card className="mb-4 p-4">
        <Label>Download report</Label>
        <p className="mb-3 text-xs text-muted">
          Export a full Comitra analytics report — all four sections, ready to print to PDF for a
          coach, therapist or your own records.
        </p>
        <Button className="w-full" onClick={exportReport}>
          {exported ? 'Downloaded ✓' : 'Export Comitra report'}
        </Button>
        <p className="mt-2 text-[11px] text-muted">
          Exports a formatted .txt summary — open and print to PDF.
        </p>
      </Card>
    </div>
  );
}

/* ───────────────────────────────── Section 1 ─────────────────────────────── */

function MotivationCard({ a }: { a: Analysis }) {
  const m = a.motivation;
  const maxDay = Math.max(1, ...m.weekdayCounts);
  const riskTone = m.risk === 'high' ? 'danger' : m.risk === 'moderate' ? 'warn' : 'accent';
  return (
    <SectionCard index={1} title="Motivation Peak" subtitle="Index of motivation & determination">
      {m.completions === 0 ? (
        <Empty>Complete a challenge to reveal when you perform best.</Empty>
      ) : (
        <>
          <p className="text-sm text-ink">
            {m.peakLabel ? (
              <>
                Your <span className="text-accent">Motivation Peak</span> is{' '}
                <span className="font-semibold text-accent">{m.peakLabel}</span> — when you close
                challenges most often, ahead of the deadline.
              </>
            ) : (
              'Not enough completions to pinpoint a peak window yet.'
            )}
          </p>

          {/* Completions by weekday */}
          <div className="mt-3 flex items-end justify-between gap-1.5" style={{ height: 84 }}>
            {m.weekdayCounts.map((c, d) => (
              <div key={d} className="flex flex-1 flex-col items-center gap-1">
                <div className="flex w-full flex-1 items-end">
                  <div
                    className={`w-full rounded-sm ${c === 0 ? 'bg-line' : 'bg-accent'} ${
                      d === m.peakWeekday && c > 0 ? 'shadow-glow' : ''
                    }`}
                    style={{ height: `${c === 0 ? 4 : Math.max(10, (c / maxDay) * 100)}%` }}
                    title={`${WEEKDAYS[d]}: ${c}`}
                  />
                </div>
                <span className="font-mono text-[9px] text-muted">{DAY_INITIAL[d]}</span>
              </div>
            ))}
          </div>

          <HourStrip buckets={m.hourBuckets} peak={m.peakHour} />

          <div className="mt-3 flex items-center justify-between border-t border-line pt-3">
            <div>
              <p className="text-xs text-muted">Avg. finish before deadline</p>
              <p className="font-mono text-sm text-ink">{m.avgLeadLabel ?? '—'}</p>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted">Procrastination</span>
              <Badge tone={riskTone as 'danger' | 'warn' | 'accent'}>
                {m.risk === 'high' ? 'High risk' : m.risk === 'moderate' ? 'Moderate' : 'Low'}
              </Badge>
            </div>
          </div>
        </>
      )}
    </SectionCard>
  );
}

/* ───────────────────────────────── Section 2 ─────────────────────────────── */

function SocialCard({ a }: { a: Analysis }) {
  const s = a.social;
  return (
    <SectionCard index={2} title="Judge Trust Score" subtitle="Who judges you, and how">
      {s.judges.length === 0 ? (
        <Empty>Have friends referee your challenges to build a judge profile.</Empty>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2">
            <JudgeTile
              label="Strictest judge"
              judge={s.strictest}
              stat={s.strictest ? `${pct(1 - s.strictest.approvalRate)} rejects` : ''}
              tone="danger"
            />
            <JudgeTile
              label="Most lenient"
              judge={s.mostLenient}
              stat={s.mostLenient ? `${pct(s.mostLenient.approvalRate)} approves` : ''}
              tone="accent"
            />
          </div>

          {s.cohort ? (
            <p className="mt-3 border-t border-line pt-3 text-sm text-ink">
              Cohort effect: <span className="font-mono text-accent">{pct(s.cohort.friendRate)}</span>{' '}
              success under friend judges vs{' '}
              <span className="font-mono text-muted">{pct(s.cohort.strangerRate)}</span> under others —
              you do{' '}
              <span className={s.cohort.delta >= 0 ? 'text-accent' : 'text-danger'}>
                {s.cohort.delta >= 0 ? 'better' : 'worse'}
              </span>{' '}
              under social pressure.
            </p>
          ) : (
            <p className="mt-3 border-t border-line pt-3 text-xs text-muted">
              Mix friend-refereed and other challenges to unlock the cohort comparison.
            </p>
          )}
        </>
      )}
    </SectionCard>
  );
}

function JudgeTile({
  label,
  judge,
  stat,
  tone,
}: {
  label: string;
  judge: { name: string; avgDecisionMs: number } | null;
  stat: string;
  tone: 'danger' | 'accent';
}) {
  return (
    <div className="rounded-lg border border-line bg-elevated p-3">
      <p className="font-mono text-[10px] uppercase tracking-widest text-muted">{label}</p>
      <p className="mt-1 truncate text-sm font-semibold text-ink">{judge?.name ?? '—'}</p>
      {judge && (
        <>
          <p className={`font-mono text-xs ${tone === 'danger' ? 'text-danger' : 'text-accent'}`}>
            {stat}
          </p>
          <p className="text-[11px] text-muted">avg {formatSpan(judge.avgDecisionMs)} to decide</p>
        </>
      )}
    </div>
  );
}

/* ───────────────────────────────── Section 4 ─────────────────────────────── */

function VulnerabilityCard({ a }: { a: Analysis }) {
  const v = a.vulnerability;
  const maxEvent = Math.max(1, ...v.weekdayEvents);
  return (
    <SectionCard index={3} title="Vulnerability Radar" subtitle="When goals slip">
      {v.events === 0 ? (
        <Empty>No missed goals recorded — nothing to flag. Keep it up.</Empty>
      ) : (
        <>
          {v.weakestDay && (
            <div className="mb-3 rounded-lg border border-danger/40 bg-danger/5 p-3">
              <p className="text-sm text-ink">
                ⚠ Your success streak drops ~
                <span className="font-mono text-danger">{v.weakestDay.dropPct}%</span> on{' '}
                <span className="text-danger">{WEEKDAYS[v.weakestDay.day]}s</span>.
              </p>
            </div>
          )}
          {v.worstMoment && (
            <p className="mb-3 text-sm text-ink">
              Most crises hit around{' '}
              <span className="font-semibold text-danger">{v.worstMoment}</span>.
            </p>
          )}

          <p className="mb-1 font-mono text-[10px] uppercase tracking-widest text-muted">
            Crisis events by weekday
          </p>
          <div className="flex items-end justify-between gap-1.5" style={{ height: 72 }}>
            {v.weekdayEvents.map((c, d) => (
              <div key={d} className="flex flex-1 flex-col items-center gap-1">
                <div className="flex w-full flex-1 items-end">
                  <div
                    className={`w-full rounded-sm ${c === 0 ? 'bg-line' : 'bg-danger'}`}
                    style={{ height: `${c === 0 ? 4 : Math.max(10, (c / maxEvent) * 100)}%` }}
                    title={`${WEEKDAYS[d]}: ${c}`}
                  />
                </div>
                <span className="font-mono text-[9px] text-muted">{DAY_INITIAL[d]}</span>
              </div>
            ))}
          </div>

          <HourStrip buckets={v.hourBuckets} tone="danger" />
        </>
      )}
    </SectionCard>
  );
}

/* ─────────────────────────────────── shared ─────────────────────────────── */

function HourStrip({
  buckets,
  peak,
  tone = 'accent',
}: {
  buckets: HourBucket[];
  peak?: HourBucket | null;
  tone?: 'accent' | 'danger';
}) {
  const max = Math.max(1, ...buckets.map((b) => b.count));
  return (
    <div className="mt-3">
      <p className="mb-1 font-mono text-[10px] uppercase tracking-widest text-muted">By time of day</p>
      <div className="flex items-end justify-between gap-1" style={{ height: 44 }}>
        {buckets.map((b) => {
          const active = b.count > 0;
          const isPeak = peak && b.start === peak.start && b.count > 0;
          return (
            <div key={b.start} className="flex flex-1 flex-col items-center gap-1">
              <div className="flex w-full flex-1 items-end">
                <div
                  className={`w-full rounded-sm ${
                    !active ? 'bg-line' : tone === 'danger' ? 'bg-danger' : 'bg-active'
                  } ${isPeak ? 'shadow-glow' : ''}`}
                  style={{ height: `${active ? Math.max(12, (b.count / max) * 100) : 4}%` }}
                  title={`${b.label}: ${b.count}`}
                />
              </div>
              <span className="font-mono text-[8px] text-muted">{b.start}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SectionCard({
  index,
  title,
  subtitle,
  children,
}: {
  index: number;
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <Card className="mb-4 p-4">
      <div className="mb-3 flex items-center gap-2">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-accent/50 font-mono text-xs text-accent">
          {index}
        </span>
        <div>
          <p className="text-sm font-semibold text-ink">{title}</p>
          <p className="font-mono text-[10px] uppercase tracking-widest text-muted">{subtitle}</p>
        </div>
      </div>
      {children}
    </Card>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="py-2 text-sm text-muted">{children}</p>;
}

function Mini({ label, value, tone }: { label: string; value: string; tone?: string }) {
  const color = tone === 'accent' ? 'text-accent' : tone === 'active' ? 'text-active' : 'text-ink';
  return (
    <Card className="p-2 text-center">
      <p className={`font-mono text-sm font-bold ${color}`}>{value}</p>
      <p className="font-mono text-[9px] uppercase tracking-widest text-muted">{label}</p>
    </Card>
  );
}
