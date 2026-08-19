import { ChangeEvent, useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import * as api from '../lib/api';
import { downscaleImage } from '../lib/image';
import type { ProfileVisibility } from '../lib/types';
import { Avatar, AVATAR_PRESETS, PresetAvatarSvg } from '../components/Avatar';
import ConfirmDialog from '../components/ConfirmDialog';
import FollowListModal from '../components/FollowListModal';
import PageHeader from '../components/PageHeader';
import ProfileGoals from '../components/ProfileGoals';
import { Badge, Button, Card, Input, Label, PremiumTag, Textarea } from '../components/ui';
import { ChevronRight } from 'lucide-react';

/** The two halves of your own profile: what people see, and everything you set. */
type Tab = 'profile' | 'settings';

const VISIBILITY_OPTIONS: { id: ProfileVisibility; label: string; blurb: string }[] = [
  { id: 'public', label: 'Public', blurb: 'Anyone can see your goals and success rate.' },
  { id: 'friends', label: 'Public for friends', blurb: 'Only people you follow who also follow you back.' },
  { id: 'private', label: 'Private', blurb: 'Only you. Your follower lists are hidden too.' },
];

export default function Profile() {
  const { user, logout, deleteAccount, refresh, patchUser } = useApp();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [tab, setTab] = useState<Tab>('profile');

  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const [bio, setBio] = useState('');
  const [avatar, setAvatar] = useState('');
  const [saveMsg, setSaveMsg] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const [stats, setStats] = useState({ followers: 0, following: 0 });
  const [followList, setFollowList] = useState<'followers' | 'following' | null>(null);
  const [goalsView, setGoalsView] = useState<api.ProfileGoalsView | null>(null);
  // Opening up is the change worth a second thought; locking down never is.
  const [confirmVisibility, setConfirmVisibility] = useState<ProfileVisibility | null>(null);

  const userId = user?.id;
  async function loadStats() {
    if (!userId) return;
    setStats(await api.getFollowStats(userId));
    // getFollowStats seeds the demo social graph on first run; resync the context
    // user so its `following` matches storage and later saves don't clobber it.
    await refresh();
  }
  useEffect(() => {
    loadStats();
    if (userId) api.getProfileGoals(userId, userId).then(setGoalsView);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  if (!user) return null;

  const visibility: ProfileVisibility = user.profileVisibility ?? (user.isPrivate ? 'private' : 'public');

  /** Private needs no confirmation; opening the profile up does. */
  function pickVisibility(next: ProfileVisibility) {
    if (next === visibility) return;
    if (next === 'private') return applyVisibility(next);
    setConfirmVisibility(next);
  }

  async function applyVisibility(next: ProfileVisibility) {
    setBusy(true);
    await patchUser({ profileVisibility: next, isPrivate: next === 'private' });
    setBusy(false);
    setConfirmVisibility(null);
  }

  const entitled = api.hasEntitlement(user);
  const subStatus = user.subscription.status;

  function startEdit() {
    setName(user!.name);
    setBio(user!.bio ?? '');
    setAvatar(user!.avatar ?? 'preset-1');
    setSaveMsg('');
    setEditing(true);
  }

  async function onPickFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setSaveMsg('Please choose an image file.');
      return;
    }
    // Guard against decoding huge originals (OOM); anything reasonable is then
    // downscaled to a small capped JPEG before it is stored.
    if (file.size > 12_000_000) {
      setSaveMsg('Image too large (max 12 MB).');
      return;
    }
    try {
      setAvatar(await downscaleImage(file));
      setSaveMsg('');
    } catch {
      setSaveMsg("Sorry, that image couldn't be processed. Try another one.");
    }
  }

  async function saveProfile() {
    if (name.trim().length < 2) {
      setSaveMsg('Name must be at least 2 characters.');
      return;
    }
    setBusy(true);
    await patchUser({ name: name.trim(), bio: bio.trim(), avatar });
    setBusy(false);
    setEditing(false);
  }

  return (
    <div className="px-4 py-5">
      <PageHeader title="Profile" />

      {/* Identity */}
      <Card className="mb-4 p-4">
        <div className="flex items-center gap-3">
          <EditAvatarButton
            onClick={() => {
              setTab('settings');
              startEdit();
            }}
          >
            <Avatar avatar={user.avatar} name={user.name} size={56} />
          </EditAvatarButton>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <p className="truncate font-semibold text-ink">{user.name}</p>
              {user.isPremium && <PremiumTag />}
              {visibility !== 'public' && (
                <Badge tone="neutral">{visibility === 'private' ? 'Private' : 'Friends only'}</Badge>
              )}
            </div>
            <p className="truncate text-xs text-muted">{user.email}</p>
            {user.bio && <p className="mt-1 line-clamp-2 text-xs text-ink">{user.bio}</p>}
          </div>
        </div>

        {/* Followers / Following, tap to open the list */}
        <div className="mt-4 grid grid-cols-2 gap-2 border-t border-line pt-3">
          <button
            onClick={() => setFollowList('followers')}
            className="rounded-lg border border-line bg-elevated py-2 text-center transition hover:border-accent"
          >
            <p className="font-mono text-xl font-bold text-ink">{stats.followers}</p>
            <p className="font-mono text-[10px] uppercase tracking-widest text-muted">Followers</p>
          </button>
          <button
            onClick={() => setFollowList('following')}
            className="rounded-lg border border-line bg-elevated py-2 text-center transition hover:border-accent"
          >
            <p className="font-mono text-xl font-bold text-ink">{stats.following}</p>
            <p className="font-mono text-[10px] uppercase tracking-widest text-muted">Following</p>
          </button>
        </div>
      </Card>

      {/* Tabs: the identity card above stays visible for both of them. */}
      <div className="mb-4 grid grid-cols-2 gap-1.5 rounded-xl border border-line bg-elevated p-1">
        {([{ id: 'profile', label: 'Profile' }, { id: 'settings', label: 'Settings' }] as const).map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`rounded-lg px-3 py-2 text-sm font-medium transition ${
              tab === t.id ? 'bg-accent text-on-accent' : 'text-muted hover:text-ink'
            }`}
            aria-pressed={tab === t.id}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'profile' && (
        <ProfileGoals view={goalsView} isOwner ownerName={user.name} />
      )}

      {tab === 'settings' && (
      <>
      {/* Edit profile */}
      {editing && (
        <Card className="mb-4 p-4">
          <Label>Profile photo</Label>
          <div className="mb-3 flex items-center gap-3">
            <Avatar avatar={avatar} name={name} size={56} />
            <div>
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                onChange={onPickFile}
                className="hidden"
              />
              <Button variant="outline" className="px-3 py-2" onClick={() => fileRef.current?.click()}>
                Upload photo
              </Button>
              <p className="mt-1 text-[11px] text-muted">PNG/JPG, max 1.5 MB.</p>
            </div>
          </div>

          <p className="mb-1.5 font-mono text-[11px] uppercase tracking-widest text-muted">
            Or pick an avatar
          </p>
          <div className="mb-3 grid grid-cols-6 gap-2">
            {AVATAR_PRESETS.map((id) => (
              <button
                key={id}
                type="button"
                onClick={() => setAvatar(id)}
                aria-label={`Avatar ${id}`}
                className={`overflow-hidden rounded-md border-2 transition ${
                  avatar === id ? 'border-accent' : 'border-transparent hover:border-line'
                }`}
              >
                <PresetAvatarSvg id={id} size={44} />
              </button>
            ))}
          </div>

          <div className="mb-3">
            <Label>Display name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" />
          </div>
          <div className="mb-3">
            <Label>Bio</Label>
            <Textarea
              rows={2}
              value={bio}
              onChange={(e) => setBio(e.target.value)}
              placeholder="A short line about you"
              maxLength={140}
            />
          </div>

          {saveMsg && <p className="mb-2 font-mono text-xs text-danger">{saveMsg}</p>}
          <div className="grid grid-cols-2 gap-2">
            <Button variant="outline" disabled={busy} onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button disabled={busy} onClick={saveProfile}>
              {busy ? 'Saving…' : 'Save profile'}
            </Button>
          </div>
        </Card>
      )}

      {/* Subscription */}
      <Card className="mb-4 p-4">
        <div className="mb-3 flex items-center justify-between">
          <span className="font-mono text-xs uppercase tracking-widest text-muted">Subscription</span>
          <Badge tone={subStatus === 'active' ? 'active' : entitled ? 'accent' : 'warn'}>
            {subStatus === 'active' ? 'Active' : entitled ? 'Trial' : subStatus}
          </Badge>
        </div>
        <p className="text-sm text-muted">
          {entitled
            ? 'You can create and run goals.'
            : 'Activate the subscription to create new goals.'}
        </p>
        <Button className="mt-3 w-full" onClick={() => navigate('/subscription')}>
          Manage subscription
        </Button>
      </Card>

      {/* Privacy: who may open your Profile tab. */}
      <Card className="mb-4 p-4">
        <div className="mb-1 flex items-center gap-2">
          <span className="font-mono text-xs uppercase tracking-widest text-muted">Who can see your goals</span>
        </div>
        <p className="mb-3 text-[11px] text-muted">Your finished goals and your success rate.</p>
        <div className="space-y-2">
          {VISIBILITY_OPTIONS.map((o) => (
            <label
              key={o.id}
              className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition ${
                visibility === o.id ? 'border-accent bg-accent/5' : 'border-line'
              }`}
            >
              <input
                type="radio"
                name="visibility"
                checked={visibility === o.id}
                disabled={busy}
                onChange={() => pickVisibility(o.id)}
                className="mt-1 h-4 w-4 shrink-0 accent-[color:rgb(var(--c-accent))]"
              />
              <div className="min-w-0">
                <p className="text-sm font-semibold text-ink">{o.label}</p>
                <p className="text-[11px] text-muted">{o.blurb}</p>
              </div>
            </label>
          ))}
        </div>
      </Card>

      {/* Navigation */}
      <div className="space-y-2">
        <NavRow label="Messages" onClick={() => navigate('/messages')} />
        <NavRow label="Subscription" onClick={() => navigate('/subscription')} />
        <NavRow label="Analytics & export" onClick={() => navigate('/analytics')} />
        <NavRow label="Themes" onClick={() => navigate('/themes')} />
        <NavRow label="Privacy Policy" onClick={() => navigate('/privacy')} />
        <NavRow label="Terms of Use" onClick={() => navigate('/terms')} />
      </div>

      <Button
        variant="outline"
        className="mt-6 w-full"
        onClick={async () => {
          await logout();
          navigate('/goals', { replace: true });
        }}
      >
        Log out
      </Button>

      <button
        onClick={() => setConfirmDelete(true)}
        className="mt-3 w-full text-center text-xs text-danger hover:underline"
      >
        Delete account
      </button>
      </>
      )}

      <ConfirmDialog
        open={confirmVisibility !== null}
        title={confirmVisibility === 'friends' ? 'Show your goals to friends?' : 'Make your profile public?'}
        confirmLabel={confirmVisibility === 'friends' ? 'Yes, show friends' : 'Yes, make it public'}
        cancelLabel="Keep it as it is"
        busy={busy}
        message={
          <>
            <span className="text-ink">{confirmVisibility === 'friends' ? 'Your friends' : 'Anyone'}</span> will
            see your finished goals and your success rate. Goals you haven't published still show as{' '}
            <span className="text-ink">“Goal #N”</span>.
          </>
        }
        onConfirm={() => applyVisibility(confirmVisibility!)}
        onCancel={() => setConfirmVisibility(null)}
      />

      <ConfirmDialog
        open={confirmDelete}
        title="Delete this account?"
        danger
        confirmLabel="Delete account"
        message={
          <>
            This permanently disables{' '}
            <span className="text-ink">{user.email}</span>, you won't be able to log back in, and
            everything on it (goals and history) becomes inaccessible. You can sign up again
            later with the same email and name, but it will start completely empty.
          </>
        }
        busy={busy}
        onConfirm={async () => {
          setBusy(true);
          await deleteAccount();
          navigate('/login', { replace: true });
        }}
        onCancel={() => setConfirmDelete(false)}
      />

      {followList && (
        <FollowListModal
          viewerId={user.id}
          targetId={user.id}
          mode={followList}
          title={followList === 'followers' ? 'Followers' : 'Following'}
          onClose={() => setFollowList(null)}
          onChanged={loadStats}
        />
      )}
    </div>
  );
}

/**
 * The avatar doubles as the "edit profile" control: a small pencil badge sits on
 * its corner, and the word "Edit" only unfolds next to it on hover (pointer
 * devices). Touch users get the same tap target without the label taking up
 * room: the `aria-label` keeps it announced either way.
 */
function EditAvatarButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Edit profile"
      title="Edit profile"
      className="group relative shrink-0 rounded-full outline-none ring-accent transition focus-visible:ring-2"
    >
      {children}
      <span className="absolute -bottom-0.5 -right-0.5 flex items-center gap-1 rounded-full border border-line bg-surface px-1.5 py-1 text-muted shadow-sm transition group-hover:border-accent group-hover:text-accent">
        <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M12 20h9" strokeLinecap="round" />
          <path d="M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4 12.5-12.5z" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        {/* Collapsed to zero width until hovered, so nothing shifts on touch. */}
        <span className="max-w-0 overflow-hidden text-[10px] font-semibold uppercase tracking-wide opacity-0 transition-all duration-200 group-hover:max-w-[3rem] group-hover:opacity-100">
          Edit
        </span>
      </span>
    </button>
  );
}

function NavRow({
  label,
  onClick,
  premium,
}: {
  label: string;
  onClick: () => void;
  premium?: boolean;
}) {
  return (
    <Card onClick={onClick} className="flex items-center justify-between p-3.5">
      <span className="text-sm text-ink">{label}</span>
      <span className="flex items-center gap-2">
        {premium && <PremiumTag />}
        <ChevronRight className="h-4 w-4 text-muted" aria-hidden />
      </span>
    </Card>
  );
}

