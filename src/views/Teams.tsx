import { FormEvent, useEffect, useState } from 'react';
import { useApp } from '../context/AppContext';
import * as api from '../lib/api';
import type { League, Team } from '../lib/types';
import PageHeader from '../components/PageHeader';
import PremiumGate from '../components/PremiumGate';
import { Button, Card, Input, Label } from '../components/ui';

const teamTotal = (t: Team) => t.members.reduce((s, m) => s + m.points, 0);

const MIN_TEAM_SIZE = 1;
const MAX_TEAM_SIZE = 10;
const DEFAULT_A = ['Alex', 'Sam', 'Riley', 'Morgan', 'Quinn', 'Avery', 'Reese', 'Parker', 'Rowan', 'Sage'];
const DEFAULT_B = ['Jordan', 'Casey', 'Taylor', 'Drew', 'Blake', 'Jamie', 'Harper', 'Emerson', 'Finley', 'Skyler'];

/** Grow/shrink a name list to exactly `size` slots, keeping existing entries. */
function resize(list: string[], size: number, fallback: string[]): string[] {
  const next = list.slice(0, size);
  while (next.length < size) next.push(fallback[next.length] ?? '');
  return next;
}

export default function Teams() {
  const { user } = useApp();
  const [leagues, setLeagues] = useState<League[]>([]);
  const [creating, setCreating] = useState(false);

  const [name, setName] = useState('');
  const [aName, setAName] = useState('Alpha Squad');
  const [bName, setBName] = useState('Bravo Squad');
  // Equal-sided by construction: one size drives both rosters.
  const [teamSize, setTeamSize] = useState(5);
  const [aMembers, setAMembers] = useState<string[]>(DEFAULT_A.slice(0, 5));
  const [bMembers, setBMembers] = useState<string[]>(DEFAULT_B.slice(0, 5));
  const [error, setError] = useState('');

  function changeSize(next: number) {
    const size = Math.max(MIN_TEAM_SIZE, Math.min(MAX_TEAM_SIZE, next));
    setTeamSize(size);
    setAMembers((prev) => resize(prev, size, DEFAULT_A));
    setBMembers((prev) => resize(prev, size, DEFAULT_B));
  }

  function setMember(team: 'A' | 'B', idx: number, value: string) {
    const setter = team === 'A' ? setAMembers : setBMembers;
    setter((prev) => prev.map((m, i) => (i === idx ? value : m)));
  }

  async function load() {
    if (user) setLeagues(await api.listLeagues(user.id));
  }
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  if (!user) return null;
  if (!user.isPremium) {
    return (
      <div className="px-4 py-5">
        <PageHeader title="Team Leagues" back />
        <PremiumGate
          title="Team vs Team"
          blurb="Build closed leagues with any equal team size and a live point ranking. Premium feature."
        />
      </div>
    );
  }

  async function create(e: FormEvent) {
    e.preventDefault();
    const a = aMembers.map((s) => s.trim()).filter(Boolean);
    const b = bMembers.map((s) => s.trim()).filter(Boolean);
    // Enforce the same number of players on each side.
    if (a.length !== teamSize || b.length !== teamSize) {
      setError(`Each team needs exactly ${teamSize} named ${teamSize === 1 ? 'player' : 'players'}.`);
      return;
    }
    setError('');
    await api.createLeague(user!.id, name, aName, a, bName, b);
    setName('');
    changeSize(5);
    setCreating(false);
    load();
  }

  async function point(leagueId: string, team: 'A' | 'B', member: string) {
    await api.addLeaguePoint(leagueId, team, member);
    load();
  }

  return (
    <div className="px-4 py-5">
      <PageHeader
        title="Team Leagues"
        subtitle="Closed leagues · equal sides · point ranking"
        back
        action={
          <Button onClick={() => setCreating((v) => !v)}>{creating ? 'Close' : '+ New'}</Button>
        }
      />

      {creating && (
        <Card className="mb-4 p-4">
          <form onSubmit={create} className="space-y-3">
            <div>
              <Label>League name</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="June Showdown" />
            </div>

            {/* Players per team — drives both rosters so sides stay equal. */}
            <div>
              <Label>Players per team</Label>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => changeSize(teamSize - 1)}
                  disabled={teamSize <= MIN_TEAM_SIZE}
                  className="h-9 w-9 rounded border border-line text-lg text-ink transition hover:border-accent disabled:opacity-40"
                  aria-label="Fewer players"
                >
                  −
                </button>
                <span className="min-w-[3ch] text-center font-mono text-xl font-bold text-accent">
                  {teamSize}v{teamSize}
                </span>
                <button
                  type="button"
                  onClick={() => changeSize(teamSize + 1)}
                  disabled={teamSize >= MAX_TEAM_SIZE}
                  className="h-9 w-9 rounded border border-line text-lg text-ink transition hover:border-accent disabled:opacity-40"
                  aria-label="More players"
                >
                  +
                </button>
                <span className="ml-1 text-[11px] text-muted">
                  {MIN_TEAM_SIZE}–{MAX_TEAM_SIZE} per side · both teams stay equal
                </span>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Team A</Label>
                <Input value={aName} onChange={(e) => setAName(e.target.value)} />
              </div>
              <div>
                <Label>Team B</Label>
                <Input value={bName} onChange={(e) => setBName(e.target.value)} />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>{aName || 'Team A'} players</Label>
                {aMembers.map((m, i) => (
                  <Input
                    key={`a-${i}`}
                    value={m}
                    onChange={(e) => setMember('A', i, e.target.value)}
                    placeholder={`Player ${i + 1}`}
                  />
                ))}
              </div>
              <div className="space-y-1.5">
                <Label>{bName || 'Team B'} players</Label>
                {bMembers.map((m, i) => (
                  <Input
                    key={`b-${i}`}
                    value={m}
                    onChange={(e) => setMember('B', i, e.target.value)}
                    placeholder={`Player ${i + 1}`}
                  />
                ))}
              </div>
            </div>

            {error && <p className="font-mono text-xs text-danger">{error}</p>}
            <Button type="submit" className="w-full">
              Create {teamSize}v{teamSize} league
            </Button>
          </form>
        </Card>
      )}

      {leagues.length === 0 && !creating ? (
        <Card className="p-6 text-center">
          <p className="text-sm text-muted">No leagues yet. Spin one up.</p>
        </Card>
      ) : (
        <div className="space-y-4">
          {leagues.map((lg) => {
            const aTot = teamTotal(lg.teamA);
            const bTot = teamTotal(lg.teamB);
            return (
              <Card key={lg.id} className="p-4">
                <div className="mb-3 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <p className="font-semibold text-ink">{lg.name}</p>
                    <span className="font-mono text-[10px] uppercase tracking-widest text-muted">
                      {lg.teamA.members.length}v{lg.teamB.members.length}
                    </span>
                  </div>
                  <button
                    onClick={async () => {
                      await api.deleteLeague(lg.id);
                      load();
                    }}
                    className="font-mono text-[10px] uppercase tracking-widest text-muted hover:text-danger"
                  >
                    Delete
                  </button>
                </div>

                {/* Scoreboard */}
                <div className="mb-4 grid grid-cols-[1fr_auto_1fr] items-center gap-3">
                  <Side name={lg.teamA.name} total={aTot} leading={aTot >= bTot} />
                  <span className="font-mono text-xs text-muted">vs</span>
                  <Side name={lg.teamB.name} total={bTot} leading={bTot > aTot} right />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <Roster team={lg.teamA} onPoint={(m) => point(lg.id, 'A', m)} />
                  <Roster team={lg.teamB} onPoint={(m) => point(lg.id, 'B', m)} />
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Side({
  name,
  total,
  leading,
  right,
}: {
  name: string;
  total: number;
  leading: boolean;
  right?: boolean;
}) {
  return (
    <div className={right ? 'text-right' : ''}>
      <p className="truncate text-sm text-ink">{name}</p>
      <p className={`font-mono text-3xl font-bold ${leading ? 'text-accent' : 'text-muted'}`}>
        {total}
      </p>
    </div>
  );
}

function Roster({ team, onPoint }: { team: Team; onPoint: (member: string) => void }) {
  const ranked = [...team.members].sort((a, b) => b.points - a.points);
  return (
    <div className="space-y-1.5">
      {ranked.map((m) => (
        <button
          key={m.name}
          onClick={() => onPoint(m.name)}
          className="flex w-full items-center justify-between rounded border border-line bg-elevated px-2.5 py-1.5 text-left transition hover:border-accent"
        >
          <span className="truncate text-xs text-ink">{m.name}</span>
          <span className="ml-2 shrink-0 font-mono text-xs text-accent">+{m.points}</span>
        </button>
      ))}
    </div>
  );
}
