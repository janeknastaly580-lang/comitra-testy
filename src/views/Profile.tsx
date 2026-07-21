import { ChangeEvent, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import * as api from '../lib/api';
import { downscaleImage } from '../lib/image';
import { Avatar, AVATAR_PRESETS, PresetAvatarSvg } from '../components/Avatar';
import ConfirmDialog from '../components/ConfirmDialog';
import FollowListModal from '../components/FollowListModal';
import PageHeader from '../components/PageHeader';
import { Badge, Button, Card, Input, Label, PremiumTag, Textarea } from '../components/ui';

export default function Profile() {
  const { user, logout, deleteAccount, refresh, patchUser } = useApp();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const [bio, setBio] = useState('');
  const [avatar, setAvatar] = useState('');
  const [saveMsg, setSaveMsg] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const [stats, setStats] = useState({ followers: 0, following: 0 });
  const [followList, setFollowList] = useState<'followers' | 'following' | null>(null);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  if (!user) return null;

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
      <PageHeader
        title="Profile"
        action={
          !editing && (
            <Button variant="outline" className="px-3 py-2" onClick={startEdit}>
              Edit
            </Button>
          )
        }
      />

      {/* Identity */}
      <Card className="mb-4 p-4">
        <div className="flex items-center gap-3">
          <Avatar avatar={user.avatar} name={user.name} size={56} />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <p className="truncate font-semibold text-ink">{user.name}</p>
              {user.isPremium && <PremiumTag />}
              {user.isPrivate && <Badge tone="neutral">Private</Badge>}
            </div>
            <p className="truncate text-xs text-muted">{user.email}</p>
            {user.bio && <p className="mt-1 line-clamp-2 text-xs text-ink">{user.bio}</p>}
          </div>
        </div>

        {/* Followers / Following — tap to open the list */}
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

      {/* Privacy */}
      <Card className="mb-4 p-4">
        <div className="mb-3 flex items-center gap-2">
          <span className="font-mono text-xs uppercase tracking-widest text-muted">Privacy</span>
        </div>
        <label className="flex items-center justify-between">
          <div className="pr-3">
            <p className="text-sm text-ink">Private profile</p>
            <p className="text-[11px] text-muted">
              When on, other people can't see who follows you or who you follow.
            </p>
          </div>
          <Toggle
            on={user.isPrivate}
            disabled={busy}
            onChange={async (v) => {
              setBusy(true);
              await patchUser({ isPrivate: v });
              setBusy(false);
            }}
          />
        </label>
      </Card>

      {/* Navigation */}
      <div className="space-y-2">
        <NavRow label="Subscription" onClick={() => navigate('/subscription')} />
        <NavRow label="Team leagues" onClick={() => navigate('/teams')} />
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

      <ConfirmDialog
        open={confirmDelete}
        title="Delete this account?"
        danger
        confirmLabel="Delete account"
        message={
          <>
            This permanently disables{' '}
            <span className="text-ink">{user.email}</span> — you won't be able to log back in, and
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
        <span className="text-muted">→</span>
      </span>
    </Card>
  );
}

function Toggle({
  on,
  onChange,
  disabled,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={`relative h-6 w-11 rounded-full border transition disabled:opacity-50 ${
        on ? 'border-accent bg-accent/20' : 'border-line bg-elevated'
      }`}
      aria-pressed={on}
    >
      <span
        className={`absolute top-0.5 h-4 w-4 rounded-full transition-all ${
          on ? 'left-[1.45rem] bg-accent' : 'left-0.5 bg-muted'
        }`}
      />
    </button>
  );
}
