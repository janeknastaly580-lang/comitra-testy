import { FormEvent, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import * as api from '../lib/api';
import type { SocialProfile } from '../lib/api';
import {
  displayGoalTemplate,
  fillGoalNumber,
  GOAL_DIFFICULTIES,
  GOAL_LIBRARY,
  goalHasNumber,
  type GoalDifficulty,
} from '../lib/constants';
import { toLocalInputValue } from '../lib/format';
import {
  CHALLENGE_MAX_POINTS,
  CHALLENGE_MAX_TEAM,
  CHALLENGE_MIN_POINTS,
  CHALLENGE_MIN_TEAM,
} from '../lib/teamChallenge';
import type { TeamChallengeMode } from '../lib/types';
import PageHeader from '../components/PageHeader';
import { Button, Card, Input, Label, Select } from '../components/ui';

const MODES: { id: TeamChallengeMode; label: string; blurb: string; target: string }[] = [
  {
    id: 'relay',
    label: 'Relay race',
    blurb: 'Two lanes. Every approved goal carries your baton further. A missed one is a stumble.',
    target: 'Goals to reach the finish line',
  },
  {
    id: 'tug_of_war',
    label: 'Tug of war',
    blurb: 'One rope. An approved goal pulls the marker your way, a missed one hands ground back.',
    target: 'Pulls needed to take the rope',
  },
];

const inDays = (days: number) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return toLocalInputValue(d);
};

/** Grow/shrink a slot list to `size` entries, keeping what's already picked. */
function resize(list: string[], size: number): string[] {
  const next = list.slice(0, size);
  while (next.length < size) next.push('');
  return next;
}

export default function CreateTeamChallenge() {
  const { user } = useApp();
  const navigate = useNavigate();
  const [friends, setFriends] = useState<SocialProfile[] | null>(null);

  const [mode, setMode] = useState<TeamChallengeMode>('relay');
  const [name, setName] = useState('');
  const [difficulty, setDifficulty] = useState<GoalDifficulty>('easy');
  const [picked, setPicked] = useState('');
  const [pickedNum, setPickedNum] = useState('');
  const [teamSize, setTeamSize] = useState(1);
  const [aName, setAName] = useState('Team A');
  const [bName, setBName] = useState('Team B');
  const [aPlayers, setAPlayers] = useState<string[]>([]);
  const [bPlayers, setBPlayers] = useState<string[]>(['']);
  const [judgeA, setJudgeA] = useState('');
  const [judgeB, setJudgeB] = useState('');
  const [points, setPoints] = useState(5);
  const [deadline, setDeadline] = useState(() => inDays(7));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (user) api.listFriends(user.id).then(setFriends);
  }, [user]);

  const numberNeeded = goalHasNumber(picked);
  const task = picked ? fillGoalNumber(picked, pickedNum) : '';
  // Creator fills one seat in team A, so they pick size − 1 team-mates.
  const friendsNeeded = teamSize * 2 + 1;

  const taken = useMemo(
    () => new Set([...aPlayers, ...bPlayers, judgeA, judgeB].filter(Boolean)),
    [aPlayers, bPlayers, judgeA, judgeB],
  );

  if (!user) return null;

  function changeSize(next: number) {
    const size = Math.max(CHALLENGE_MIN_TEAM, Math.min(CHALLENGE_MAX_TEAM, next));
    setTeamSize(size);
    setAPlayers((prev) => resize(prev, size - 1));
    setBPlayers((prev) => resize(prev, size));
  }

  function setSlot(team: 'A' | 'B', idx: number, value: string) {
    const setter = team === 'A' ? setAPlayers : setBPlayers;
    setter((prev) => prev.map((v, i) => (i === idx ? value : v)));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (!picked) return setError('Choose the goal both teams will compete on.');
    if (numberNeeded && !pickedNum) return setError('Fill in the number in your goal.');
    if (aPlayers.some((v) => !v) || bPlayers.some((v) => !v)) {
      return setError('Every player slot has to be filled — both teams must be the same size.');
    }
    if (!judgeA || !judgeB) return setError('Each team needs its own judge.');

    setBusy(true);
    try {
      const challenge = await api.createTeamChallenge({
        creatorUserId: user!.id,
        mode,
        name,
        task,
        teamSize,
        teamAName: aName,
        teamBName: bName,
        pointsToWin: points,
        deadlineAt: new Date(deadline).toISOString(),
        teamAPlayerIds: aPlayers,
        teamBPlayerIds: bPlayers,
        judgeAUserId: judgeA,
        judgeBUserId: judgeB,
      });
      navigate(`/challenge/${challenge.id}`, { replace: true });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (friends !== null && friends.length < 3) {
    return (
      <div className="px-4 py-5">
        <PageHeader title="New challenge" back />
        <Card className="p-6 text-center">
          <p className="font-mono text-[10px] uppercase tracking-widest text-muted">Not enough friends</p>
          <p className="mt-2 text-sm text-ink">
            A challenge needs at least three friends: one opponent and a judge for each team.
          </p>
          <p className="mt-1 text-[12px] text-muted">
            Friends are people you follow who follow you back. You have {friends.length}.
          </p>
          <Button className="mt-4 w-full" onClick={() => navigate('/social')}>
            Find people
          </Button>
        </Card>
      </div>
    );
  }

  const modeMeta = MODES.find((m) => m.id === mode)!;

  return (
    <div className="px-4 py-5">
      <PageHeader title="New challenge" subtitle="Two equal teams, one goal, two judges" back />

      <form onSubmit={submit} className="space-y-5">
        {/* ── Mode ───────────────────────────────────────────────── */}
        <div>
          <Label>Challenge type</Label>
          <div className="space-y-2">
            {MODES.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => setMode(m.id)}
                className={`w-full rounded-xl border p-3 text-left transition ${
                  mode === m.id ? 'border-accent bg-accent/10' : 'border-line hover:border-accent/60'
                }`}
              >
                <p
                  className={`font-mono text-[10px] uppercase tracking-widest ${
                    mode === m.id ? 'text-accent' : 'text-muted'
                  }`}
                >
                  {m.label}
                </p>
                <p className="mt-1 text-[12px] text-muted">{m.blurb}</p>
              </button>
            ))}
          </div>
        </div>

        {/* ── Name + goal ────────────────────────────────────────── */}
        <div>
          <Label>Challenge name</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Friday showdown" />
        </div>

        <div>
          <Label>The goal both teams compete on</Label>
          <div className="mb-2 flex gap-1.5">
            {GOAL_DIFFICULTIES.map((d) => (
              <button
                key={d.id}
                type="button"
                onClick={() => {
                  setDifficulty(d.id);
                  setPicked('');
                  setPickedNum('');
                }}
                className={`flex-1 rounded-lg border px-3 py-1.5 text-xs font-medium transition ${
                  difficulty === d.id
                    ? 'border-accent bg-accent/10 text-accent'
                    : 'border-line text-muted hover:text-ink'
                }`}
              >
                {d.label}
              </button>
            ))}
          </div>
          <Select
            value={picked}
            onChange={(e) => {
              setPicked(e.target.value);
              setPickedNum('');
            }}
          >
            <option value="" disabled>
              Choose a {GOAL_DIFFICULTIES.find((d) => d.id === difficulty)?.label.toLowerCase()} goal…
            </option>
            {GOAL_LIBRARY[difficulty].map((g) => (
              <option key={g} value={g}>
                {displayGoalTemplate(g)}
              </option>
            ))}
          </Select>
          {numberNeeded && (
            <div className="mt-2">
              <p className="mb-1 font-mono text-[11px] uppercase tracking-widest text-muted">
                Your goal — edit only the number
              </p>
              <GoalWithNumber template={picked} value={pickedNum} onChange={setPickedNum} />
            </div>
          )}
          <p className="mt-2 text-[11px] text-muted">
            Everyone in the challenge sees this goal, so it's picked from the safe list.
          </p>
        </div>

        {/* ── Teams ──────────────────────────────────────────────── */}
        <Card className="p-4">
          <Label>Players per team</Label>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => changeSize(teamSize - 1)}
              disabled={teamSize <= CHALLENGE_MIN_TEAM}
              className="h-9 w-9 rounded border border-line text-lg text-ink transition hover:border-accent disabled:opacity-40"
              aria-label="Fewer players"
            >
              −
            </button>
            <span className="min-w-[3.5ch] text-center font-mono text-xl font-bold text-accent">
              {teamSize}v{teamSize}
            </span>
            <button
              type="button"
              onClick={() => changeSize(teamSize + 1)}
              disabled={teamSize >= CHALLENGE_MAX_TEAM}
              className="h-9 w-9 rounded border border-line text-lg text-ink transition hover:border-accent disabled:opacity-40"
              aria-label="More players"
            >
              +
            </button>
            <span className="ml-1 text-[11px] text-muted">
              Both teams stay equal · needs {friendsNeeded} friends
              {friends ? ` (you have ${friends.length})` : ''}
            </span>
          </div>

          <div className="mt-4 grid grid-cols-2 gap-3">
            <div>
              <Label>Team A name</Label>
              <Input value={aName} onChange={(e) => setAName(e.target.value)} />
            </div>
            <div>
              <Label>Team B name</Label>
              <Input value={bName} onChange={(e) => setBName(e.target.value)} />
            </div>
          </div>

          <div className="mt-4 grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>{aName || 'Team A'}</Label>
              <div className="rounded-xl border border-accent/40 bg-accent/5 px-3 py-2 text-sm text-ink">
                {user.name} <span className="font-mono text-[10px] uppercase tracking-widest text-accent">You</span>
              </div>
              {aPlayers.map((v, i) => (
                <FriendSelect
                  key={`a-${i}`}
                  friends={friends}
                  taken={taken}
                  value={v}
                  placeholder={`Player ${i + 2}`}
                  onChange={(next) => setSlot('A', i, next)}
                />
              ))}
            </div>
            <div className="space-y-1.5">
              <Label>{bName || 'Team B'}</Label>
              {bPlayers.map((v, i) => (
                <FriendSelect
                  key={`b-${i}`}
                  friends={friends}
                  taken={taken}
                  value={v}
                  placeholder={`Player ${i + 1}`}
                  onChange={(next) => setSlot('B', i, next)}
                />
              ))}
            </div>
          </div>

          <div className="mt-4 grid grid-cols-2 gap-3">
            <div>
              <Label>Judge · {aName || 'Team A'}</Label>
              <FriendSelect
                friends={friends}
                taken={taken}
                value={judgeA}
                placeholder="Pick a judge"
                onChange={setJudgeA}
              />
            </div>
            <div>
              <Label>Judge · {bName || 'Team B'}</Label>
              <FriendSelect
                friends={friends}
                taken={taken}
                value={judgeB}
                placeholder="Pick a judge"
                onChange={setJudgeB}
              />
            </div>
          </div>
          <p className="mt-2 text-[11px] text-muted">
            Each judge only rules on their own team's goals, and has to accept the role before the challenge
            can start.
          </p>
        </Card>

        {/* ── Target + deadline ──────────────────────────────────── */}
        <div>
          <Label>{modeMeta.target}</Label>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setPoints((p) => Math.max(CHALLENGE_MIN_POINTS, p - 1))}
              disabled={points <= CHALLENGE_MIN_POINTS}
              className="h-9 w-9 rounded border border-line text-lg text-ink transition hover:border-accent disabled:opacity-40"
              aria-label="Lower target"
            >
              −
            </button>
            <span className="min-w-[3ch] text-center font-mono text-xl font-bold text-accent">{points}</span>
            <button
              type="button"
              onClick={() => setPoints((p) => Math.min(CHALLENGE_MAX_POINTS, p + 1))}
              disabled={points >= CHALLENGE_MAX_POINTS}
              className="h-9 w-9 rounded border border-line text-lg text-ink transition hover:border-accent disabled:opacity-40"
              aria-label="Raise target"
            >
              +
            </button>
            <span className="ml-1 text-[11px] text-muted">
              {mode === 'relay'
                ? 'Approved goals needed to cross the line.'
                : 'How far the rope has to move to win.'}
            </span>
          </div>
        </div>

        <div>
          <Label>Challenge ends</Label>
          <Input type="datetime-local" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
          <p className="mt-1 text-[11px] text-muted">
            If nobody has reached the target by then, whoever is ahead wins.
          </p>
        </div>

        {error && <p className="font-mono text-xs text-danger">{error}</p>}
        <Button type="submit" className="w-full" disabled={busy || friends === null}>
          {busy ? 'Sending…' : 'Send invitations'}
        </Button>
        <p className="pb-2 text-center text-[11px] text-muted">
          Everyone you picked has to accept before the challenge starts.
        </p>
      </form>
    </div>
  );
}

/** A friend picker that hides people already holding another seat. */
function FriendSelect({
  friends,
  taken,
  value,
  placeholder,
  onChange,
}: {
  friends: SocialProfile[] | null;
  taken: Set<string>;
  value: string;
  placeholder: string;
  onChange: (v: string) => void;
}) {
  const options = (friends ?? []).filter((f) => f.id === value || !taken.has(f.id));
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{placeholder}</option>
      {options.map((f) => (
        <option key={f.id} value={f.id}>
          {f.name}
        </option>
      ))}
    </Select>
  );
}

/**
 * A picked goal shown as a sentence where only the `{n}` slot can be edited.
 * Mirrors the goal-creation screen so a challenge goal reads identically.
 */
function GoalWithNumber({
  template,
  value,
  onChange,
}: {
  template: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const [before, after = ''] = template.split('{n}');
  return (
    <div className="flex flex-wrap items-center gap-x-1 gap-y-1 rounded-xl border border-line bg-elevated px-3.5 py-3 text-sm text-ink">
      <span>{before}</span>
      <input
        inputMode="numeric"
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, ''))}
        placeholder="N"
        aria-label="Number"
        className="w-14 rounded-md border border-accent/60 bg-surface px-2 py-0.5 text-center font-semibold text-accent outline-none transition focus:border-accent"
      />
      <span>{after}</span>
    </div>
  );
}
