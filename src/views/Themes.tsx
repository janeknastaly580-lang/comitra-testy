import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import { THEMES } from '../lib/constants';
import type { ThemeId } from '../lib/types';
import PageHeader from '../components/PageHeader';
import { Badge, Button, Card, PremiumTag } from '../components/ui';

export default function Themes() {
  const { user, setTheme } = useApp();
  const navigate = useNavigate();
  if (!user) return null;

  function choose(id: ThemeId, locked: boolean) {
    if (locked) {
      navigate('/premium');
      return;
    }
    setTheme(id);
  }

  return (
    <div className="px-4 py-5">
      <PageHeader title="Themes & Widgets" subtitle="Customize the interface" back />

      <div className="space-y-3">
        {THEMES.map((t) => {
          const locked = t.premium && !user.isPremium;
          const selected = user.theme === t.id;
          return (
            <Card
              key={t.id}
              className={`p-4 ${selected ? 'border-accent shadow-glow' : ''}`}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="flex gap-1">
                    {t.swatch.map((c, i) => (
                      <span
                        key={i}
                        className="h-7 w-7 rounded border border-black/40"
                        style={{ background: c }}
                      />
                    ))}
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-ink">{t.name}</span>
                      {t.premium && <PremiumTag />}
                    </div>
                    {selected && <Badge tone="accent">Active</Badge>}
                  </div>
                </div>
                <Button
                  variant={selected ? 'outline' : 'primary'}
                  disabled={selected}
                  onClick={() => choose(t.id, locked)}
                >
                  {selected ? 'In use' : locked ? 'Unlock' : 'Apply'}
                </Button>
              </div>
            </Card>
          );
        })}
      </div>

      {/* Android home-screen widget preview */}
      <h2 className="mb-3 mt-6 flex items-center gap-2 font-mono text-xs uppercase tracking-widest text-muted">
        Home-screen widgets <PremiumTag />
      </h2>

      <div className="grid grid-cols-2 gap-3">
        <WidgetPreview
          title="Active goal"
          locked={!user.isPremium}
          body={
            <>
              <p className="font-mono text-[10px] uppercase tracking-widest text-muted">Deadline</p>
              <p className="font-mono text-lg font-bold text-accent">2d 4h</p>
              <div className="mt-2 h-1.5 w-full rounded bg-line">
                <div className="h-full w-2/3 rounded bg-accent" />
              </div>
            </>
          }
        />
        <WidgetPreview
          title="Judge"
          locked={!user.isPremium}
          body={
            <>
              <p className="font-mono text-[10px] uppercase tracking-widest text-muted">Status</p>
              <p className="font-mono text-lg font-bold text-active">Accepted</p>
              <p className="mt-2 text-[11px] text-muted">Awaiting decision</p>
            </>
          }
        />
      </div>
      {!user.isPremium && (
        <p className="mt-3 text-center text-[11px] text-muted">
          Exclusive themes require an active{' '}
          <button onClick={() => navigate('/subscription')} className="text-active hover:underline">
            subscription
          </button>
          .
        </p>
      )}
    </div>
  );
}

function WidgetPreview({
  title,
  body,
  locked,
}: {
  title: string;
  body: ReactNode;
  locked: boolean;
}) {
  return (
    <div className="relative rounded-lg border border-line bg-elevated p-3">
      <p className="mb-1 font-mono text-[10px] font-bold tracking-widest text-ink">{title}</p>
      <div className={locked ? 'blur-[2px] opacity-60' : ''}>{body}</div>
      {locked && (
        <span className="absolute right-2 top-2 text-muted">
          <svg viewBox="0 0 24 24" className="h-4 w-4" stroke="currentColor" strokeWidth="1.8">
            <path
              d="M6 10V8a6 6 0 0112 0v2M5 10h14v10H5z"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      )}
    </div>
  );
}
