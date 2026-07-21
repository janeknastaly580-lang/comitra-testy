import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import * as api from '../lib/api';
import type {
  LeaderboardCategory,
  LeaderboardEntry,
  Leaderboards,
  Relationship,
  SocialProfile,
} from '../lib/api';
import { smartSearch } from '../lib/search';
import { Avatar } from '../components/Avatar';
import AuthModal from '../components/AuthModal';
import PageHeader from '../components/PageHeader';
import { Badge, Button, Card, Input } from '../components/ui';

const DEFAULT_LIMIT = 15;

const STATUS_BADGE: Record<Relationship, { label: string; tone: 'accent' | 'active' | 'neutral' } | null> = {
  friends: { label: 'Friends', tone: 'accent' },
  following: { label: 'Following', tone: 'active' },
  'follows-you': { label: 'Follows you', tone: 'neutral' },
  none: null,
};

const fmtCount = (n: number) =>
  n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n);

export default function Social() {
  const { user, refresh } = useApp();
  const navigate = useNavigate();
  const [profiles, setProfiles] = useState<SocialProfile[]>([]);
  const [query, setQuery] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [authOpen, setAuthOpen] = useState(false);
  const [tab, setTab] = useState<'discover' | 'leaderboard'>('discover');

  async function load() {
    if (!user) return;
    const list = await api.listProfiles(user.id);
    setProfiles(list);
    return list;
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  const searching = query.trim().length > 0;

  // Default (no query): the 15 most-followed profiles. Search: smart ranked, full set.
  const displayed = useMemo(() => {
    if (searching) return smartSearch(profiles, query);
    return [...profiles].sort((a, b) => b.followers - a.followers).slice(0, DEFAULT_LIMIT);
  }, [profiles, query, searching]);

  const friends = useMemo(() => profiles.filter((p) => p.status === 'friends'), [profiles]);

  if (!user) return null;

  async function toggle(targetId: string) {
    // Guests can browse but must sign up before following anyone.
    if (user!.isGuest) {
      setAuthOpen(true);
      return;
    }
    setBusyId(targetId);
    await api.toggleFollow(user!.id, targetId);
    await load();
    await refresh();
    setBusyId(null);
  }

  function openProfile(id: string) {
    navigate(`/u/${id}`);
  }

  return (
    <div className="px-4 py-5">
      <PageHeader
        title="Social"
        subtitle="Find people · build your network"
        action={
          <Button
            variant="outline"
            className="gap-1.5 px-3 py-2"
            onClick={() => navigate('/feature-requests')}
          >
            <span aria-hidden>💡</span> Ideas
          </Button>
        }
      />

      {/* Sub-tabs: Discover / Leaderboard */}
      <div className="mb-5 grid grid-cols-2 gap-1 rounded-lg border border-line bg-elevated p-1">
        <TabButton active={tab === 'discover'} onClick={() => setTab('discover')} label="Discover" />
        <TabButton
          active={tab === 'leaderboard'}
          onClick={() => setTab('leaderboard')}
          label="Leaderboard"
        />
      </div>

      {tab === 'leaderboard' ? (
        <Leaderboard viewerId={user.id} onOpenProfile={openProfile} />
      ) : (
        DiscoverBody()
      )}

      <AuthModal
        open={authOpen}
        onClose={() => setAuthOpen(false)}
        title="Create an account to follow"
        subtitle="Guests can browse profiles, but following people needs an account."
      />
    </div>
  );

  function DiscoverBody() {
    return (
      <>
      {/* My Friends */}
      <h2 className="mb-2 font-mono text-xs uppercase tracking-widest text-muted">
        My Friends <span className="text-line">{friends.length}</span>
      </h2>
      {friends.length === 0 ? (
        <Card className="mb-5 p-4 text-center">
          <p className="text-sm text-muted">
            No friends yet. Follow someone who follows you back to become friends.
          </p>
        </Card>
      ) : (
        <div className="mb-5 flex gap-3 overflow-x-auto pb-1">
          {friends.map((f) => (
            <button
              key={f.id}
              onClick={() => openProfile(f.id)}
              className="flex w-16 shrink-0 flex-col items-center gap-1"
            >
              <Avatar avatar={f.avatar} name={f.name} size={48} />
              <span className="w-full truncate text-center text-[11px] text-ink">
                {f.name.split(' ')[0]}
              </span>
            </button>
          ))}
        </div>
      )}

      {/* Search */}
      <div className="relative mb-3">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search people…"
          className="pl-9"
        />
        <svg
          viewBox="0 0 24 24"
          className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
        >
          <circle cx="11" cy="11" r="7" />
          <path d="M21 21l-4.3-4.3" strokeLinecap="round" />
        </svg>
        {searching && (
          <button
            onClick={() => setQuery('')}
            aria-label="Clear search"
            className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted hover:text-ink"
          >
            ✕
          </button>
        )}
      </div>

      <h2 className="mb-2 font-mono text-xs uppercase tracking-widest text-muted">
        {searching ? `Results · ${displayed.length}` : 'Suggested · most followed'}
      </h2>

      {displayed.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted">No people match “{query}”.</p>
      ) : (
        <div className="space-y-2">
          {displayed.map((p) => (
            <ProfileRow
              key={p.id}
              profile={p}
              busy={busyId === p.id}
              onOpen={() => openProfile(p.id)}
              onToggle={() => toggle(p.id)}
            />
          ))}
        </div>
      )}
      </>
    );
  }
}

function TabButton({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      className={`rounded-md py-2 text-sm font-medium transition ${
        active ? 'bg-surface text-ink shadow-sm' : 'text-muted hover:text-ink'
      }`}
    >
      {label}
    </button>
  );
}

function followLabel(status: Relationship) {
  if (status === 'friends' || status === 'following') return 'Unfollow';
  return status === 'follows-you' ? 'Follow back' : 'Follow';
}

function ProfileRow({
  profile,
  busy,
  onOpen,
  onToggle,
}: {
  profile: SocialProfile;
  busy: boolean;
  onOpen: () => void;
  onToggle: () => void;
}) {
  const badge = STATUS_BADGE[profile.status];
  const isFollowing = profile.status === 'friends' || profile.status === 'following';
  return (
    <Card onClick={onOpen} className="flex items-center gap-3 p-3">
      <Avatar avatar={profile.avatar} name={profile.name} size={44} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="truncate text-sm font-semibold text-ink">{profile.name}</p>
          {badge && <Badge tone={badge.tone}>{badge.label}</Badge>}
        </div>
        <p className="truncate text-[11px] text-muted">
          {fmtCount(profile.followers)} followers{profile.bio ? ` · ${profile.bio}` : ''}
        </p>
      </div>
      <Button
        variant={isFollowing ? 'outline' : 'primary'}
        disabled={busy}
        onClick={(e) => {
          e.stopPropagation();
          onToggle();
        }}
        className="shrink-0 px-3 py-2"
      >
        {followLabel(profile.status)}
      </Button>
    </Card>
  );
}

/* ------------------------------------------------------------- Leaderboard */

const CATEGORIES: { id: LeaderboardCategory; label: string; blurb: string }[] = [
  { id: 'completions', label: 'Most completed', blurb: 'Most completed goals' },
  { id: 'consistency', label: 'Consistency', blurb: 'Highest % of goals completed' },
];

function formatValue(cat: LeaderboardCategory, value: number): string {
  if (cat === 'consistency') return `${value}%`;
  return `${value} ${value === 1 ? 'goal' : 'goals'}`;
}

function Leaderboard({
  viewerId,
  onOpenProfile,
}: {
  viewerId: string;
  onOpenProfile: (id: string) => void;
}) {
  const { user } = useApp();
  const navigate = useNavigate();
  const [cat, setCat] = useState<LeaderboardCategory>('completions');
  const [boards, setBoards] = useState<Leaderboards | null>(null);

  useEffect(() => {
    let live = true;
    api.getLeaderboards(viewerId).then((b) => {
      if (live) setBoards(b);
    });
    return () => {
      live = false;
    };
  }, [viewerId]);

  const active = CATEGORIES.find((c) => c.id === cat)!;
  const rows = boards?.[cat] ?? [];

  return (
    <div>
      {/* Category switch */}
      <div className="mb-3 flex gap-2 overflow-x-auto pb-1">
        {CATEGORIES.map((c) => (
          <button
            key={c.id}
            onClick={() => setCat(c.id)}
            className={`shrink-0 rounded-full border px-3 py-1.5 text-xs font-medium transition ${
              cat === c.id
                ? 'border-accent bg-accent/10 text-accent'
                : 'border-line text-muted hover:text-ink'
            }`}
          >
            {c.label}
          </button>
        ))}
      </div>

      <p className="mb-3 text-[11px] text-muted">
        {active.blurb} · Premium members only · Top {rows.length || 100}
      </p>

      {user && user.plan !== 'premium' && (
        <Card className="mb-3 border-active/30 p-3">
          <p className="text-xs text-ink">You need Premium to appear on the leaderboard.</p>
          <button
            onClick={() => navigate('/premium')}
            className="mt-1 text-xs text-active hover:underline"
          >
            Upgrade to Premium →
          </button>
        </Card>
      )}

      {boards === null ? (
        <p className="py-8 text-center text-sm text-muted">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted">
          No Premium members ranked here yet.
        </p>
      ) : (
        <div className="space-y-1.5">
          {rows.map((entry, i) => (
            <LeaderboardRow
              key={entry.id}
              rank={i + 1}
              entry={entry}
              category={cat}
              onOpen={() => onOpenProfile(entry.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

const RANK_COLOR = ['text-warn', 'text-muted', 'text-active'];

function LeaderboardRow({
  rank,
  entry,
  category,
  onOpen,
}: {
  rank: number;
  entry: LeaderboardEntry;
  category: LeaderboardCategory;
  onOpen: () => void;
}) {
  return (
    <Card
      onClick={entry.isMe ? undefined : onOpen}
      className={`flex items-center gap-3 p-2.5 ${entry.isMe ? 'border-accent' : ''}`}
    >
      <span
        className={`w-6 shrink-0 text-center font-mono text-sm font-bold ${
          rank <= 3 ? RANK_COLOR[rank - 1] : 'text-muted'
        }`}
      >
        {rank}
      </span>
      <Avatar avatar={entry.avatar} name={entry.name} size={36} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-ink">
          {entry.name}
          {entry.isMe && <span className="ml-1 text-[11px] text-accent">(you)</span>}
        </p>
      </div>
      <span className="shrink-0 font-mono text-sm font-bold text-accent">
        {formatValue(category, entry.value)}
      </span>
    </Card>
  );
}
