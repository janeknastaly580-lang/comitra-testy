import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import * as api from '../lib/api';
import { countdown } from '../lib/format';
import {
  leaderOf,
  memberForUser,
  pendingMembers,
  sideScore,
  sideName,
} from '../lib/teamChallenge';
import type { TeamChallenge } from '../lib/types';
import { SIDE_STYLE } from '../components/challenge/common';
import PageHeader from '../components/PageHeader';
import { Badge, Button, Card } from '../components/ui';

const MODE_LABEL: Record<TeamChallenge['mode'], string> = {
  relay: 'Relay race',
  tug_of_war: 'Tug of war',
};

/** Demo friends act on a timer, so the list refreshes itself while it's open. */
const POLL_MS = 4000;

export default function TeamChallenges() {
  const { user } = useApp();
  const navigate = useNavigate();
  const [items, setItems] = useState<TeamChallenge[] | null>(null);

  const load = useCallback(async () => {
    if (user) setItems(await api.listTeamChallenges(user.id));
  }, [user]);

  useEffect(() => {
    load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  if (!user) return null;

  const invites = (items ?? []).filter(
    (c) => c.status === 'pending_invites' && memberForUser(c, user.id)?.inviteStatus === 'pending',
  );
  const waiting = (items ?? []).filter(
    (c) => c.status === 'pending_invites' && memberForUser(c, user.id)?.inviteStatus === 'accepted',
  );
  const running = (items ?? []).filter((c) => c.status === 'active');
  const over = (items ?? []).filter((c) => c.status === 'finished' || c.status === 'cancelled');

  async function respond(challengeId: string, accept: boolean) {
    await api.respondToChallengeInvite(challengeId, user!.id, accept);
    load();
  }

  return (
    <div className="px-4 py-5">
      <PageHeader
        title="Team challenges"
        subtitle="Two teams, same size, one goal"
        back
        action={<Button onClick={() => navigate('/challenges/new')}>+ New</Button>}
      />

      {items === null ? (
        <p className="py-10 text-center text-sm text-muted">Loading…</p>
      ) : items.length === 0 ? (
        <Card className="border-accent/40 bg-accent/5 p-5">
          <p className="font-mono text-[10px] uppercase tracking-widest text-accent">Team challenge</p>
          <p className="mt-1 text-base font-semibold text-ink">Take on your friends</p>
          <p className="mt-1 text-[12px] text-muted">
            Pick a goal, split into two equal teams of 1 to 8, and give each team a judge. Every goal your
            judge approves moves your team down the track — or drags the rope your way.
          </p>
          <Button className="mt-3 w-full" onClick={() => navigate('/challenges/new')}>
            Start a challenge
          </Button>
        </Card>
      ) : (
        <div className="space-y-6">
          {invites.length > 0 && (
            <section>
              <h2 className="mb-2 font-mono text-xs uppercase tracking-widest text-accent">
                Invitation · {invites.length}
              </h2>
              <div className="space-y-3">
                {invites.map((c) => {
                  const me = memberForUser(c, user.id)!;
                  return (
                    <Card key={c.id} className="border-accent/40 bg-accent/5 p-4">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate font-semibold text-ink">{c.name}</p>
                          <p className="mt-0.5 font-mono text-[10px] uppercase tracking-widest text-muted">
                            {MODE_LABEL[c.mode]} · {c.teamSize}v{c.teamSize}
                          </p>
                        </div>
                        <Badge tone="accent">{me.role === 'judge' ? 'Judge' : 'Player'}</Badge>
                      </div>
                      <p className="mt-2 text-[13px] text-ink">“{c.task}”</p>
                      <p className="mt-1 text-[11px] text-muted">
                        {me.role === 'judge'
                          ? `You'd decide every goal for ${sideName(c, me.side)}.`
                          : `You'd play for ${sideName(c, me.side)}.`}
                      </p>
                      <div className="mt-3 flex gap-2">
                        <Button className="flex-1" onClick={() => respond(c.id, true)}>
                          Accept
                        </Button>
                        <Button variant="outline" className="flex-1" onClick={() => respond(c.id, false)}>
                          Decline
                        </Button>
                      </div>
                    </Card>
                  );
                })}
              </div>
            </section>
          )}

          {running.length > 0 && (
            <Section title="Running">
              {running.map((c) => (
                <ChallengeRow key={c.id} challenge={c} onOpen={() => navigate(`/challenge/${c.id}`)} />
              ))}
            </Section>
          )}

          {waiting.length > 0 && (
            <Section title="Waiting for answers">
              {waiting.map((c) => (
                <ChallengeRow key={c.id} challenge={c} onOpen={() => navigate(`/challenge/${c.id}`)} />
              ))}
            </Section>
          )}

          {over.length > 0 && (
            <Section title="Finished">
              {over.map((c) => (
                <ChallengeRow key={c.id} challenge={c} onOpen={() => navigate(`/challenge/${c.id}`)} />
              ))}
            </Section>
          )}
        </div>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="mb-2 font-mono text-xs uppercase tracking-widest text-muted">{title}</h2>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

function ChallengeRow({ challenge, onOpen }: { challenge: TeamChallenge; onOpen: () => void }) {
  const a = sideScore(challenge, 'A');
  const b = sideScore(challenge, 'B');
  const leader = leaderOf(challenge);
  // Relay is won on approvals; tug of war on the net pull — showing approvals
  // there would make the winner look like they scored less.
  const tug = challenge.mode === 'tug_of_war';
  const show = (s: typeof a) => (tug ? (s.net > 0 ? `+${s.net}` : `${s.net}`) : `${s.approved}`);
  const cd = countdown(challenge.deadlineAt);
  const stillPending = pendingMembers(challenge).length;

  const state =
    challenge.status === 'cancelled'
      ? { tone: 'danger' as const, text: 'Called off' }
      : challenge.status === 'finished'
        ? challenge.winner === 'draw'
          ? { tone: 'neutral' as const, text: 'Draw' }
          : { tone: 'accent' as const, text: `${sideName(challenge, challenge.winner as 'A' | 'B')} won` }
        : challenge.status === 'pending_invites'
          ? { tone: 'warn' as const, text: `${stillPending} to accept` }
          : { tone: 'active' as const, text: cd.label };

  return (
    <Card onClick={onOpen} className="p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-semibold text-ink">{challenge.name}</p>
          <p className="mt-0.5 font-mono text-[10px] uppercase tracking-widest text-muted">
            {MODE_LABEL[challenge.mode]} · {challenge.teamSize}v{challenge.teamSize}
          </p>
        </div>
        <Badge tone={state.tone}>{state.text}</Badge>
      </div>

      <div className="mt-3 flex items-center gap-3 border-t border-line pt-3">
        <p className={`min-w-0 flex-1 truncate text-[13px] ${leader === 'A' ? SIDE_STYLE.A.text : 'text-ink'}`}>
          {challenge.teamAName}
        </p>
        <p className="shrink-0 font-mono text-sm font-bold text-ink">
          <span className={leader === 'A' ? SIDE_STYLE.A.text : ''}>{show(a)}</span>
          <span className="text-muted"> · </span>
          <span className={leader === 'B' ? SIDE_STYLE.B.text : ''}>{show(b)}</span>
        </p>
        <p
          className={`min-w-0 flex-1 truncate text-right text-[13px] ${
            leader === 'B' ? SIDE_STYLE.B.text : 'text-ink'
          }`}
        >
          {challenge.teamBName}
        </p>
      </div>
    </Card>
  );
}
