import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import * as api from '../lib/api';
import { countdown, dateTime } from '../lib/format';
import {
  judgeOf,
  memberForUser,
  membersOf,
  pendingMembers,
  sideName,
} from '../lib/teamChallenge';
import type { ChallengeMember, TeamChallenge, TeamSide } from '../lib/types';
import { Avatar } from '../components/Avatar';
import ChallengeBoard from '../components/challenge/ChallengeBoard';
import { SIDE_STYLE } from '../components/challenge/common';
import PageHeader from '../components/PageHeader';
import { Badge, Button, Card, Input } from '../components/ui';

const MODE_LABEL: Record<TeamChallenge['mode'], string> = {
  relay: 'Relay race',
  tug_of_war: 'Tug of war',
};

/** Judges and demo friends act while this screen is open, so it re-reads. */
const POLL_MS = 3000;

export default function TeamChallengeDetail() {
  const { id = '' } = useParams();
  const { user } = useApp();
  const navigate = useNavigate();
  const [challenge, setChallenge] = useState<TeamChallenge | null | 'missing'>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const found = await api.getTeamChallenge(id);
    setChallenge(found ?? 'missing');
  }, [id]);

  useEffect(() => {
    load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  if (!user) return null;
  if (challenge === null) {
    return (
      <div className="px-4 py-5">
        <PageHeader title="Challenge" back />
        <p className="py-10 text-center text-sm text-muted">Loading…</p>
      </div>
    );
  }
  if (challenge === 'missing') {
    return (
      <div className="px-4 py-5">
        <PageHeader title="Challenge" back />
        <Card className="p-6 text-center">
          <p className="text-sm text-muted">This challenge no longer exists.</p>
          <Button className="mt-4 w-full" onClick={() => navigate('/challenges')}>
            Back to challenges
          </Button>
        </Card>
      </div>
    );
  }

  const c = challenge;
  const me = memberForUser(c, user.id);
  const myOpenTask = me ? c.tasks.find((t) => t.memberId === me.id && t.status === 'pending') : undefined;
  const myJudgeQueue =
    me?.role === 'judge' ? c.tasks.filter((t) => t.side === me.side && t.status === 'pending') : [];
  const cd = countdown(c.deadlineAt);

  async function run(action: () => Promise<unknown>) {
    setError('');
    setBusy(true);
    try {
      await action();
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const memberName = (memberId: string) => c.members.find((m) => m.id === memberId)?.name ?? 'Someone';

  return (
    <div className="px-4 py-5">
      <PageHeader
        title={c.name}
        subtitle={`${MODE_LABEL[c.mode]} · ${c.teamSize}v${c.teamSize}`}
        back
      />

      {/* ── The board ───────────────────────────────────────────── */}
      <ChallengeBoard challenge={c} />

      {/* ── What everyone is doing ──────────────────────────────── */}
      <Card className="mt-4 p-4">
        <p className="font-mono text-[10px] uppercase tracking-widest text-muted">The goal</p>
        <p className="mt-1 text-sm font-semibold text-ink">“{c.task}”</p>
        <div className="mt-3 flex items-center justify-between border-t border-line pt-3">
          <p className="font-mono text-[10px] uppercase tracking-widest text-muted">
            {c.status === 'active' ? 'Ends' : 'Deadline'}
          </p>
          <p className={`font-mono text-sm ${cd.overdue ? 'text-danger' : 'text-ink'}`}>
            {c.status === 'active' ? cd.label : dateTime(c.deadlineAt)}
          </p>
        </div>
      </Card>

      {error && <p className="mt-3 font-mono text-xs text-danger">{error}</p>}

      {/* ── Status / my move ────────────────────────────────────── */}
      {c.status === 'pending_invites' && (
        <Card className="mt-4 p-4">
          <p className="font-mono text-[10px] uppercase tracking-widest text-warn">Not started yet</p>
          {me?.inviteStatus === 'pending' ? (
            <>
              <p className="mt-1.5 text-sm text-ink">
                You've been invited as{' '}
                <span className="font-semibold">
                  {me.role === 'judge' ? `the judge of ${sideName(c, me.side)}` : `a player for ${sideName(c, me.side)}`}
                </span>
                .
              </p>
              <div className="mt-3 flex gap-2">
                <Button className="flex-1" disabled={busy} onClick={() => run(() => api.respondToChallengeInvite(c.id, user.id, true))}>
                  Accept challenge
                </Button>
                <Button
                  variant="outline"
                  className="flex-1"
                  disabled={busy}
                  onClick={() => run(() => api.respondToChallengeInvite(c.id, user.id, false))}
                >
                  Decline
                </Button>
              </div>
            </>
          ) : (
            <>
              <p className="mt-1.5 text-sm text-ink">
                Waiting for {pendingMembers(c).length} more{' '}
                {pendingMembers(c).length === 1 ? 'person' : 'people'} to accept. Nobody scores until
                everyone is in.
              </p>
              <ul className="mt-2 space-y-1">
                {pendingMembers(c).map((m) => (
                  <li key={m.id} className="font-mono text-[11px] text-muted">
                    · {m.name} {m.role === 'judge' ? '(judge)' : ''}
                  </li>
                ))}
              </ul>
              {c.createdByUserId === user.id && (
                <Button
                  variant="outline"
                  className="mt-3 w-full"
                  disabled={busy}
                  onClick={() => run(() => api.cancelTeamChallenge(c.id, user.id))}
                >
                  Call it off
                </Button>
              )}
            </>
          )}
        </Card>
      )}

      {c.status === 'active' && me?.role === 'player' && (
        <Card className="mt-4 p-4">
          <p className="font-mono text-[10px] uppercase tracking-widest text-accent">Your move</p>
          {myOpenTask ? (
            <p className="mt-1.5 text-sm text-ink">
              Sent to {judgeOf(c, me.side)?.name ?? 'your judge'} — waiting for their decision.
            </p>
          ) : (
            <>
              <p className="mt-1.5 text-sm text-ink">
                Done it? {judgeOf(c, me.side)?.name ?? 'Your judge'} decides whether it counts.
              </p>
              <Input
                className="mt-2"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Anything your judge should know (optional)"
              />
              <Button
                className="mt-2 w-full"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    await api.submitChallengeTask(c.id, user.id, note);
                    setNote('');
                  })
                }
              >
                I did it
              </Button>
            </>
          )}
        </Card>
      )}

      {c.status === 'active' && me?.role === 'judge' && (
        <Card className="mt-4 p-4">
          <p className="font-mono text-[10px] uppercase tracking-widest text-accent">
            You judge {sideName(c, me.side)}
          </p>
          {myJudgeQueue.length === 0 ? (
            <p className="mt-1.5 text-sm text-muted">Nothing to decide right now.</p>
          ) : (
            <div className="mt-2 space-y-2">
              {myJudgeQueue.map((t) => (
                <div key={t.id} className="rounded-xl border border-line bg-elevated p-3">
                  <p className="text-sm font-semibold text-ink">{memberName(t.memberId)}</p>
                  <p className="mt-0.5 text-[12px] text-muted">“{t.title}”</p>
                  {t.note && <p className="mt-1 text-[12px] text-ink">Note: {t.note}</p>}
                  <div className="mt-2 flex gap-2">
                    <Button
                      className="flex-1"
                      disabled={busy}
                      onClick={() => run(() => api.decideChallengeTask(c.id, t.id, user.id, 'approved'))}
                    >
                      Approve
                    </Button>
                    <Button
                      variant="outline"
                      className="flex-1"
                      disabled={busy}
                      onClick={() => run(() => api.decideChallengeTask(c.id, t.id, user.id, 'rejected'))}
                    >
                      Reject
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      {c.status === 'finished' && (
        <Card className="mt-4 border-accent/40 bg-accent/5 p-4 text-center">
          <p className="font-mono text-[10px] uppercase tracking-widest text-accent">Result</p>
          <p className="mt-1 text-lg font-bold text-ink">
            {c.winner === 'draw' ? 'Dead heat — nobody took it.' : `${sideName(c, c.winner as TeamSide)} won`}
          </p>
          {c.createdByUserId === user.id && (
            <Button
              variant="outline"
              className="mt-3 w-full"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await api.deleteTeamChallenge(c.id, user.id);
                  navigate('/challenges', { replace: true });
                })
              }
            >
              Remove from my list
            </Button>
          )}
        </Card>
      )}

      {c.status === 'cancelled' && (
        <Card className="mt-4 p-4">
          <p className="font-mono text-[10px] uppercase tracking-widest text-danger">Called off</p>
          <p className="mt-1.5 text-sm text-ink">
            {c.declinedByName
              ? `${c.declinedByName} turned the invite down, so the challenge never started. Teams have to be equal, so it can't run a player short.`
              : 'This challenge was called off before it started.'}
          </p>
          {c.createdByUserId === user.id && (
            <Button
              variant="outline"
              className="mt-3 w-full"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await api.deleteTeamChallenge(c.id, user.id);
                  navigate('/challenges', { replace: true });
                })
              }
            >
              Remove from my list
            </Button>
          )}
        </Card>
      )}

      {/* ── Line-ups ────────────────────────────────────────────── */}
      <h2 className="mb-2 mt-6 font-mono text-xs uppercase tracking-widest text-muted">Line-ups</h2>
      <div className="grid grid-cols-2 gap-3">
        <Roster challenge={c} side="A" meId={user.id} />
        <Roster challenge={c} side="B" meId={user.id} />
      </div>

      {/* ── Decision feed ───────────────────────────────────────── */}
      {c.tasks.length > 0 && (
        <>
          <h2 className="mb-2 mt-6 font-mono text-xs uppercase tracking-widest text-muted">Decisions</h2>
          <div className="space-y-1.5">
            {c.tasks.slice(0, 12).map((t) => (
              <div
                key={t.id}
                className="flex items-center justify-between rounded-xl border border-line bg-surface px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="truncate text-[13px] text-ink">{memberName(t.memberId)}</p>
                  <p className="font-mono text-[10px] uppercase tracking-widest text-muted">
                    {sideName(c, t.side)} · {dateTime(t.decidedAt ?? t.createdAt)}
                  </p>
                </div>
                <Badge tone={t.status === 'approved' ? 'accent' : t.status === 'rejected' ? 'danger' : 'warn'}>
                  {t.status === 'approved' ? 'Counted' : t.status === 'rejected' ? 'Missed' : 'Waiting'}
                </Badge>
              </div>
            ))}
          </div>
        </>
      )}

      {c.members.some((m) => m.demo) && (
        <p className="mt-4 text-center text-[11px] text-muted">
          Some people here are demo profiles — they answer and compete on their own so you can see how a
          challenge plays out.
        </p>
      )}
    </div>
  );
}

function Roster({
  challenge,
  side,
  meId,
}: {
  challenge: TeamChallenge;
  side: TeamSide;
  meId: string;
}) {
  const style = SIDE_STYLE[side];
  const members = membersOf(challenge, side);
  return (
    <div className="rounded-2xl border border-line/60 bg-surface p-3">
      <p className={`font-mono text-[10px] uppercase tracking-widest ${style.text}`}>
        {sideName(challenge, side)}
      </p>
      <div className="mt-2 space-y-2">
        {members.map((m) => (
          <MemberRow key={m.id} member={m} isMe={m.userId === meId} />
        ))}
      </div>
    </div>
  );
}

function MemberRow({ member, isMe }: { member: ChallengeMember; isMe: boolean }) {
  const status =
    member.inviteStatus === 'accepted'
      ? { text: 'In', tone: 'text-accent' }
      : member.inviteStatus === 'declined'
        ? { text: 'Out', tone: 'text-danger' }
        : { text: 'Asked', tone: 'text-warn' };
  return (
    <div className="flex items-center gap-2">
      <Avatar avatar={member.avatar} name={member.name} size={26} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] text-ink">
          {member.name}
          {isMe && <span className="ml-1 font-mono text-[9px] uppercase tracking-widest text-accent">You</span>}
        </p>
        <p className="font-mono text-[9px] uppercase tracking-widest text-muted">
          {member.role === 'judge' ? 'Judge' : 'Player'}
          {member.demo ? ' · demo' : ''}
        </p>
      </div>
      <span className={`shrink-0 font-mono text-[9px] uppercase tracking-widest ${status.tone}`}>
        {status.text}
      </span>
    </div>
  );
}
