import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import * as api from '../lib/api';
import type { Relationship, SocialProfile } from '../lib/api';
import { statusMeta } from '../lib/status';
import type { Goal } from '../lib/types';
import { Avatar } from '../components/Avatar';
import AuthModal from '../components/AuthModal';
import FollowListModal from '../components/FollowListModal';
import PageHeader from '../components/PageHeader';
import { Badge, Button, Card } from '../components/ui';

const STATUS_BADGE: Record<Relationship, { label: string; tone: 'accent' | 'active' | 'neutral' } | null> = {
  friends: { label: 'Friends', tone: 'accent' },
  following: { label: 'Following', tone: 'active' },
  'follows-you': { label: 'Follows you', tone: 'neutral' },
  none: null,
};

const fmtCount = (n: number) =>
  n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n);

function followLabel(status: Relationship) {
  if (status === 'friends' || status === 'following') return 'Unfollow';
  return status === 'follows-you' ? 'Follow back' : 'Follow';
}

/**
 * Dedicated public-profile page (Instagram-style), reached by tapping a user in
 * the Social tab. Shows the person's avatar, network counts, and completed
 * challenges. Private challenges hide their content to outside viewers — only the
 * outcome and the amount staked remain. Guests can browse but must sign up to
 * follow. Visiting your own id renders an owner view (no follow button).
 */
export default function UserProfile() {
  const { user, refresh } = useApp();
  const { userId } = useParams<{ userId: string }>();
  const navigate = useNavigate();

  const [profile, setProfile] = useState<SocialProfile | null>(null);
  const [goals, setGoals] = useState<Goal[] | null>(null);
  const [judgeRating, setJudgeRating] = useState<{ avg: number; count: number }>({ avg: 0, count: 0 });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [list, setList] = useState<'followers' | 'following' | null>(null);
  const [authOpen, setAuthOpen] = useState(false);

  const viewerId = user?.id;

  async function load() {
    if (!viewerId || !userId) return;
    const p = await api.getProfile(viewerId, userId);
    setProfile(p);
    setLoading(false);
    if (p) {
      api.listCompletedGoals(userId).then(setGoals);
      api.getJudgeRatingSummary(userId).then(setJudgeRating);
    }
  }

  useEffect(() => {
    setLoading(true);
    setGoals(null);
    setJudgeRating({ avg: 0, count: 0 });
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewerId, userId]);

  if (!user) return null;

  const isOwner = profile?.id === user.id;

  async function toggle() {
    if (!profile) return;
    // Guests can browse but cannot build a social graph until they sign up.
    if (user!.isGuest) {
      setAuthOpen(true);
      return;
    }
    setBusy(true);
    await api.toggleFollow(user!.id, profile.id);
    await refresh();
    await load();
    setBusy(false);
  }

  const badge = profile ? STATUS_BADGE[profile.status] : null;
  const isFollowing = profile?.status === 'friends' || profile?.status === 'following';

  return (
    <div className="px-4 py-5">
      <PageHeader title="Profile" back />

      {loading ? (
        <p className="py-16 text-center text-sm text-muted">Loading…</p>
      ) : !profile ? (
        <Card className="p-6 text-center">
          <p className="font-mono text-xs uppercase tracking-widest text-muted">Not found</p>
          <p className="mt-2 text-sm text-muted">This account doesn't exist anymore.</p>
          <Button variant="outline" className="mt-4" onClick={() => navigate('/social')}>
            Back to Social
          </Button>
        </Card>
      ) : (
        <>
          <Card className="p-5">
            <div className="flex flex-col items-center text-center">
              <Avatar avatar={profile.avatar} name={profile.name} size={80} />
              <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
                <p className="text-xl font-bold text-ink">{profile.name}</p>
                {badge && <Badge tone={badge.tone}>{badge.label}</Badge>}
                {profile.isPrivate && <Badge tone="neutral">Private</Badge>}
              </div>
              {profile.bio && <p className="mt-1 text-sm text-muted">{profile.bio}</p>}

              {judgeRating.count > 0 && (
                <div className="mt-2 flex items-center gap-1.5 rounded-full bg-accent/10 px-3 py-1">
                  <span className="text-accent">★</span>
                  <span className="font-mono text-sm font-bold text-ink">{judgeRating.avg.toFixed(2)}</span>
                  <span className="text-[11px] text-muted">judge rating · {judgeRating.count}</span>
                </div>
              )}

              <div className="mt-4 grid w-full grid-cols-2 border-y border-line">
                <button
                  onClick={() => setList('followers')}
                  className="border-r border-line py-3 transition hover:bg-elevated"
                >
                  <p className="font-mono text-lg font-bold text-ink">{fmtCount(profile.followers)}</p>
                  <p className="font-mono text-[10px] uppercase tracking-widest text-muted">Followers</p>
                </button>
                <button
                  onClick={() => setList('following')}
                  className="py-3 transition hover:bg-elevated"
                >
                  <p className="font-mono text-lg font-bold text-ink">{fmtCount(profile.following)}</p>
                  <p className="font-mono text-[10px] uppercase tracking-widest text-muted">Following</p>
                </button>
              </div>
              {profile.isPrivate && !isOwner && (
                <p className="mt-2 text-[11px] text-muted">
                  This account is private — its follower lists are hidden.
                </p>
              )}

              {isOwner ? (
                <Button
                  variant="outline"
                  className="mt-4 w-full"
                  onClick={() => navigate('/profile')}
                >
                  This is you · Edit profile
                </Button>
              ) : (
                <Button
                  variant={isFollowing ? 'outline' : 'primary'}
                  disabled={busy}
                  onClick={toggle}
                  className="mt-4 w-full"
                >
                  {followLabel(profile.status)}
                </Button>
              )}
            </div>
          </Card>

          {/* Completed challenges — outcome + whether money was staked. */}
          <h2 className="mb-2 mt-5 font-mono text-xs uppercase tracking-widest text-muted">
            Completed challenges {goals && `· ${goals.length}`}
          </h2>
          {goals === null ? (
            <p className="py-6 text-center text-xs text-muted">Loading…</p>
          ) : goals.length === 0 ? (
            <Card className="p-5 text-center">
              <p className="text-sm text-muted">No completed challenges yet.</p>
            </Card>
          ) : (
            <div className="space-y-1.5">
              {goals.map((g) => (
                <CompletedGoalRow key={g.id} goal={g} hideContent={!!g.isPrivate && !isOwner} />
              ))}
            </div>
          )}
        </>
      )}

      {list && profile && (
        <FollowListModal
          viewerId={user.id}
          targetId={profile.id}
          mode={list}
          title={`${profile.name.split(' ')[0]} · ${list === 'followers' ? 'Followers' : 'Following'}`}
          onClose={() => setList(null)}
        />
      )}

      <AuthModal
        open={authOpen}
        onClose={() => setAuthOpen(false)}
        title="Create an account to follow"
        subtitle="Guests can browse profiles, but following people needs an account."
      />
    </div>
  );
}

function CompletedGoalRow({ goal, hideContent }: { goal: Goal; hideContent: boolean }) {
  const meta = statusMeta(goal.status);
  return (
    <div className="flex items-center gap-2 rounded border border-line bg-elevated px-3 py-2.5">
      <div className="min-w-0 flex-1">
        {hideContent ? (
          <p className="flex items-center gap-1.5 truncate text-xs font-medium text-muted">
            <span aria-hidden>🔒</span> Private goal
          </p>
        ) : (
          <p className="truncate text-xs font-medium text-ink">{goal.title}</p>
        )}
      </div>
      <Badge tone={meta.tone}>{meta.short}</Badge>
    </div>
  );
}
