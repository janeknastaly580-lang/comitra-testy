import { Avatar } from '../Avatar';
import { playersOf, relayPct, sideScore } from '../../lib/teamChallenge';
import type { TeamChallenge, TeamSide } from '../../lib/types';
import { SIDE_STYLE, useChangeTick } from './common';

/**
 * Relay race: two parallel lanes, one baton per team.
 *
 * Every goal the team's judge approves carries the baton further down the lane.
 * A rejected goal is a stumble — the runner trips in place and the other team
 * keeps going. First baton over the finish line wins.
 */
export default function RelayTrack({ challenge }: { challenge: TeamChallenge }) {
  return (
    <div className="rounded-2xl border border-line/60 bg-surface p-4">
      <div className="flex items-baseline justify-between">
        <p className="font-mono text-[10px] uppercase tracking-widest text-muted">Relay race</p>
        <p className="font-mono text-[10px] uppercase tracking-widest text-muted">
          Finish · {challenge.pointsToWin}
        </p>
      </div>

      <div className="mt-3 space-y-3">
        <Lane challenge={challenge} side="A" />
        <Lane challenge={challenge} side="B" />
      </div>
    </div>
  );
}

function Lane({ challenge, side }: { challenge: TeamChallenge; side: TeamSide }) {
  const style = SIDE_STYLE[side];
  const score = sideScore(challenge, side);
  const pct = relayPct(challenge, side);
  const players = playersOf(challenge, side);
  const name = side === 'A' ? challenge.teamAName : challenge.teamBName;

  // The latest verdict on this lane drives the animation: approved → the runner
  // surges forward, rejected → they trip in place.
  const lastDecided = challenge.tasks
    .filter((t) => t.side === side && t.status !== 'pending')
    .sort((a, b) => +new Date(b.decidedAt ?? b.createdAt) - +new Date(a.decidedAt ?? a.createdAt))[0];
  const tick = useChangeTick(lastDecided?.id);
  const stumbling = lastDecided?.status === 'rejected';

  return (
    <div>
      <div className="mb-1.5 flex items-center gap-2">
        <div className="flex items-center gap-1">
          {players.slice(0, 3).map((m) => (
            <Avatar key={m.id} avatar={m.avatar} name={m.name} size={20} />
          ))}
          {players.length > 3 && (
            <span className="font-mono text-[10px] text-muted">+{players.length - 3}</span>
          )}
        </div>
        <p className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">{name}</p>
        <p className={`font-mono text-sm font-bold ${style.text}`}>
          {score.approved}
          <span className="text-muted">/{challenge.pointsToWin}</span>
        </p>
      </div>

      <div className="relative h-11 overflow-hidden rounded-xl border border-line bg-elevated">
        {/* Ground covered so far, in the team's colour. */}
        <div
          className={`absolute inset-y-0 left-0 transition-[width] duration-700 ease-out ${style.softFill}`}
          style={{ width: `${pct}%` }}
        />
        {/* Lane markings */}
        <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 border-t border-dashed border-line" />
        {/* Finish line */}
        <div className="absolute inset-y-0 right-0 w-3 finish-flag" />

        {/* The baton carrier. `left` plus a matching negative translate keeps the
            chip inside the lane at both ends without any pixel maths. */}
        <div
          className="absolute top-1/2 transition-all duration-700 ease-out"
          style={{ left: `${pct}%`, transform: `translate(-${pct}%, -50%)` }}
        >
          <div
            key={tick}
            className={tick === 0 ? '' : stumbling ? 'challenge-stumble' : 'challenge-pop'}
          >
            <div
              className={`flex h-8 w-8 items-center justify-center rounded-full border-2 bg-surface ${
                stumbling ? 'border-danger' : style.border
              }`}
            >
              <svg
                viewBox="0 0 24 24"
                className={`h-4 w-4 ${stumbling ? 'text-danger' : style.text}`}
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                aria-hidden
              >
                {/* Relay baton */}
                <path d="M6 18L18 6" strokeLinecap="round" />
                <path d="M4.5 19.5a2.1 2.1 0 003 0 2.1 2.1 0 000-3l-3 3zM16.5 7.5a2.1 2.1 0 003 0 2.1 2.1 0 000-3 2.1 2.1 0 00-3 0 2.1 2.1 0 000 3z" />
              </svg>
            </div>
          </div>
        </div>
      </div>

      <p className="mt-1 font-mono text-[9px] uppercase tracking-widest text-muted">
        {score.rejected > 0 ? `${score.rejected} stumble${score.rejected > 1 ? 's' : ''}` : 'No stumbles'}
        {score.pending > 0 ? ` · ${score.pending} waiting on the judge` : ''}
      </p>
    </div>
  );
}
