import { useCallback, useEffect, useState } from 'react';
import * as api from '../lib/api';
import type { Relationship, SocialProfile } from '../lib/api';
import { useApp } from '../context/AppContext';
import { Avatar } from './Avatar';
import { Badge, Button } from './ui';

const STATUS_BADGE: Record<Relationship, { label: string; tone: 'accent' | 'active' | 'neutral' } | null> = {
  friends: { label: 'Friends', tone: 'accent' },
  following: { label: 'Following', tone: 'active' },
  'follows-you': { label: 'Follows you', tone: 'neutral' },
  none: null,
};

function followLabel(status: Relationship) {
  if (status === 'friends' || status === 'following') return 'Unfollow';
  return status === 'follows-you' ? 'Follow back' : 'Follow';
}

/**
 * Bottom-sheet-style modal listing either the followers of a profile, or who a
 * profile follows. Respects private profiles (the API returns `hidden`). When the
 * list belongs to the current user, each row can be followed / unfollowed inline.
 */
export default function FollowListModal({
  viewerId,
  targetId,
  mode,
  title,
  onClose,
  onChanged,
}: {
  viewerId: string;
  targetId: string;
  mode: 'followers' | 'following';
  title: string;
  onClose: () => void;
  /** Fired after a follow/unfollow so the opener can refresh its own counts. */
  onChanged?: () => void;
}) {
  const { user } = useApp();
  // Guests aren't accounts — they can browse these lists but can't follow from them.
  const canFollow = !!user && !user.isGuest;
  const [profiles, setProfiles] = useState<SocialProfile[]>([]);
  const [hidden, setHidden] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const fn = mode === 'followers' ? api.listFollowers : api.listFollowing;
    const res = await fn(viewerId, targetId);
    setProfiles(res.profiles);
    setHidden(res.hidden);
    setLoading(false);
  }, [mode, viewerId, targetId]);

  useEffect(() => {
    load();
  }, [load]);

  async function toggle(id: string) {
    if (!canFollow) return;
    setBusyId(id);
    await api.toggleFollow(viewerId, id);
    await load();
    onChanged?.();
    setBusyId(null);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-5"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div
        className="max-h-[80%] w-full max-w-[340px] overflow-hidden rounded-t-2xl border border-line bg-surface sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <p className="font-mono text-xs uppercase tracking-widest text-muted">{title}</p>
          <button onClick={onClose} aria-label="Close" className="p-1 text-muted hover:text-ink">
            ✕
          </button>
        </div>

        <div className="max-h-[65vh] overflow-y-auto p-3 phone-scroll">
          {loading ? (
            <p className="py-8 text-center text-sm text-muted">Loading…</p>
          ) : hidden ? (
            <div className="flex flex-col items-center gap-2 py-10 text-center">
              <svg viewBox="0 0 24 24" className="h-7 w-7 text-muted" stroke="currentColor" strokeWidth="1.7" fill="none">
                <path d="M6 10V8a6 6 0 0112 0v2M5 10h14v10H5z" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <p className="text-sm text-muted">This account is private.</p>
              <p className="text-[11px] text-muted">You can't see who they follow or who follows them.</p>
            </div>
          ) : profiles.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted">Nobody here yet.</p>
          ) : (
            <div className="space-y-2">
              {profiles.map((p) => {
                const badge = STATUS_BADGE[p.status];
                const isFollowing = p.status === 'friends' || p.status === 'following';
                return (
                  <div key={p.id} className="flex items-center gap-3 rounded-lg border border-line bg-elevated p-2.5">
                    <Avatar avatar={p.avatar} name={p.name} size={40} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="truncate text-sm font-semibold text-ink">{p.name}</p>
                        {badge && <Badge tone={badge.tone}>{badge.label}</Badge>}
                      </div>
                      {p.bio && <p className="truncate text-[11px] text-muted">{p.bio}</p>}
                    </div>
                    {canFollow && (
                      <Button
                        variant={isFollowing ? 'outline' : 'primary'}
                        disabled={busyId === p.id}
                        onClick={() => toggle(p.id)}
                        className="shrink-0 px-3 py-1.5"
                      >
                        {followLabel(p.status)}
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
