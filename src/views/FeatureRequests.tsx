import { FormEvent, useEffect, useState } from 'react';
import { useApp } from '../context/AppContext';
import * as api from '../lib/api';
import { shortDate } from '../lib/format';
import type { FeatureRequestView } from '../lib/types';
import PageHeader from '../components/PageHeader';
import { Badge, Button, Card, Input, Label, Textarea } from '../components/ui';

export default function FeatureRequests() {
  const { user } = useApp();
  const [items, setItems] = useState<FeatureRequestView[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [votingId, setVotingId] = useState<string | null>(null);

  async function load() {
    if (!user) return;
    const list = await api.listFeatureRequests(user.id);
    setItems(list);
    setLoading(false);
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  if (!user) return null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await api.createFeatureRequest(user!.id, user!.name, title, description);
      setTitle('');
      setDescription('');
      setShowForm(false);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function vote(id: string, dir: 1 | -1) {
    setVotingId(id);
    try {
      const updated = await api.voteFeatureRequest(user!.id, id, dir);
      // Update + re-sort locally so the list re-ranks immediately.
      setItems((prev) =>
        prev
          .map((f) => (f.id === id ? updated : f))
          .sort((a, b) => b.score - a.score || +new Date(b.createdAt) - +new Date(a.createdAt)),
      );
    } finally {
      setVotingId(null);
    }
  }

  return (
    <div className="px-4 py-5">
      <PageHeader
        title="Feature Requests"
        subtitle="Vote on what we build next"
        back
        action={
          <Button className="px-3 py-2" onClick={() => setShowForm((s) => !s)}>
            {showForm ? 'Close' : '+ Suggest'}
          </Button>
        }
      />

      {/* Suggestion form */}
      {showForm && (
        <Card className="mb-4 p-4">
          <form onSubmit={submit} className="space-y-3">
            <div>
              <Label>Idea title</Label>
              <Input
                required
                maxLength={80}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Group challenges"
              />
            </div>
            <div>
              <Label>Short description</Label>
              <Textarea
                rows={3}
                maxLength={280}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What should it do, and why is it useful?"
              />
            </div>
            {error && <p className="font-mono text-xs text-danger">{error}</p>}
            <Button type="submit" disabled={busy} className="w-full">
              {busy ? 'Posting…' : 'Post idea'}
            </Button>
          </form>
        </Card>
      )}

      {/* List */}
      {loading ? (
        <p className="py-6 text-center text-sm text-muted">Loading ideas…</p>
      ) : items.length === 0 ? (
        <Card className="p-6 text-center">
          <p className="text-sm text-muted">No ideas yet — be the first to suggest one.</p>
        </Card>
      ) : (
        <div className="space-y-2">
          {items.map((f, i) => (
            <FeatureRow
              key={f.id}
              feature={f}
              rank={i + 1}
              mine={f.authorId === user.id}
              busy={votingId === f.id}
              onVote={(dir) => vote(f.id, dir)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function FeatureRow({
  feature,
  rank,
  mine,
  busy,
  onVote,
}: {
  feature: FeatureRequestView;
  rank: number;
  mine: boolean;
  busy: boolean;
  onVote: (dir: 1 | -1) => void;
}) {
  return (
    <Card className="flex items-stretch gap-3 p-3">
      {/* Vote control */}
      <div className="flex w-11 shrink-0 flex-col items-center justify-center rounded-md border border-line bg-elevated py-1">
        <VoteButton
          dir={1}
          active={feature.myVote === 1}
          disabled={busy}
          onClick={() => onVote(1)}
        />
        <span
          className={`font-mono text-sm font-bold ${
            feature.score > 0 ? 'text-accent' : feature.score < 0 ? 'text-danger' : 'text-muted'
          }`}
        >
          {feature.score}
        </span>
        <VoteButton
          dir={-1}
          active={feature.myVote === -1}
          disabled={busy}
          onClick={() => onVote(-1)}
        />
      </div>

      {/* Body */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[10px] text-muted">#{rank}</span>
          <p className="truncate text-sm font-semibold text-ink">{feature.title}</p>
          {mine && <Badge tone="accent">You</Badge>}
        </div>
        {feature.description && (
          <p className="mt-0.5 text-xs text-muted">{feature.description}</p>
        )}
        <p className="mt-1 font-mono text-[10px] uppercase tracking-widest text-muted">
          {feature.authorName} · {shortDate(feature.createdAt)} · ▲ {feature.upCount} ▼{' '}
          {feature.downCount}
        </p>
      </div>
    </Card>
  );
}

function VoteButton({
  dir,
  active,
  disabled,
  onClick,
}: {
  dir: 1 | -1;
  active: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-label={dir === 1 ? 'Upvote' : 'Downvote'}
      aria-pressed={active}
      className={`p-0.5 transition disabled:opacity-40 ${
        active
          ? dir === 1
            ? 'text-accent'
            : 'text-danger'
          : 'text-muted hover:text-ink'
      }`}
    >
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.4">
        {dir === 1 ? (
          <path d="M6 15l6-6 6 6" strokeLinecap="round" strokeLinejoin="round" />
        ) : (
          <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
        )}
      </svg>
    </button>
  );
}
