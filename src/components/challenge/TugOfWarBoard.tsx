import { Avatar } from '../Avatar';
import {
  leaderOf,
  playersOf,
  sideScore,
  tugMarkerPct,
  tugPull,
} from '../../lib/teamChallenge';
import type { TeamChallenge, TeamSide } from '../../lib/types';
import { SIDE_STYLE, useChangeTick } from './common';

/**
 * Tug of war: one rope, one marker.
 *
 * An approved goal drags the marker toward the team that scored it; a rejected
 * one drags it the other way. The rope tints in the leading team's colour and
 * the bar underneath shows how far past centre they've pulled. A side wins by
 * dragging the marker all the way to its end.
 */
export default function TugOfWarBoard({ challenge }: { challenge: TeamChallenge }) {
  const pull = tugPull(challenge);
  const markerPct = tugMarkerPct(challenge);
  const leader = leaderOf(challenge);
  // Replays the marker's kick animation on every score change.
  const tick = useChangeTick(pull);

  const advantagePct = Math.min(50, (Math.abs(pull) / Math.max(1, challenge.pointsToWin)) * 50);
  const flag = leader ? SIDE_STYLE[leader] : null;

  return (
    <div className="rounded-2xl border border-line/60 bg-surface p-4">
      <p className="font-mono text-[10px] uppercase tracking-widest text-muted">Tug of war</p>

      {/* Team A on the left, team B on the right — the rope runs between them. */}
      <div className="mt-3 flex items-start justify-between gap-3">
        <TeamHead challenge={challenge} side="A" />
        <div className="shrink-0 pt-1 text-center">
          <p className="font-mono text-[10px] uppercase tracking-widest text-muted">Rope</p>
          <p className="font-mono text-xs font-bold text-ink">
            {pull === 0 ? 'Even' : `${Math.abs(pull)} / ${challenge.pointsToWin}`}
          </p>
        </div>
        <TeamHead challenge={challenge} side="B" align="right" />
      </div>

      {/* The rope */}
      <div className="relative mt-4 h-14">
        {/* Backdrop tinted with whoever is winning the pull. */}
        <div
          className={`absolute inset-x-0 top-1/2 h-9 -translate-y-1/2 rounded-xl transition-colors duration-500 ${
            flag ? flag.tint : 'bg-elevated/50'
          }`}
        />
        {/* End zones — drag the marker into one and that team wins. */}
        <div className="absolute inset-y-0 left-0 flex w-8 items-center justify-center">
          <span className="font-mono text-[8px] uppercase tracking-widest text-muted">Win</span>
        </div>
        <div className="absolute inset-y-0 right-0 flex w-8 items-center justify-center">
          <span className="font-mono text-[8px] uppercase tracking-widest text-muted">Win</span>
        </div>

        <div className="absolute inset-x-0 top-1/2 h-2.5 -translate-y-1/2 rounded-full border border-line rope-texture" />
        {/* Centre mark, so it's obvious which way the rope has moved. */}
        <div className="absolute left-1/2 top-1/2 h-7 w-px -translate-x-1/2 -translate-y-1/2 bg-line" />

        {/* The marker itself */}
        <div
          className="absolute top-1/2 transition-all duration-700 ease-out"
          style={{ left: `${markerPct}%`, transform: `translate(-${markerPct}%, -50%)` }}
        >
          <div key={tick} className={tick === 0 ? '' : 'challenge-pop'}>
            <svg viewBox="0 0 24 32" className="h-8 w-6" aria-hidden>
              <path d="M6 2v28" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-ink" />
              <path
                d="M7 3l13 5-13 5z"
                className={flag ? flag.text : 'text-muted'}
                fill="currentColor"
              />
            </svg>
          </div>
        </div>
      </div>

      {/* Advantage bar: grows out of the centre toward the leading team. */}
      <div className="relative mt-1 h-1.5 overflow-hidden rounded-full bg-elevated">
        <div className="absolute inset-y-0 left-1/2 w-px bg-line" />
        <div
          className={`absolute inset-y-0 rounded-full transition-all duration-700 ease-out ${
            leader ? SIDE_STYLE[leader].fill : ''
          }`}
          style={
            leader === 'A'
              ? { right: '50%', width: `${advantagePct}%` }
              : leader === 'B'
                ? { left: '50%', width: `${advantagePct}%` }
                : { left: '50%', width: 0 }
          }
        />
      </div>

      <p className="mt-2 text-center text-[11px] text-muted">
        {leader === null
          ? 'Dead even — the next decision moves the rope.'
          : `${leader === 'A' ? challenge.teamAName : challenge.teamBName} is pulling ahead by ${Math.abs(pull)}.`}
      </p>
    </div>
  );
}

function TeamHead({
  challenge,
  side,
  align,
}: {
  challenge: TeamChallenge;
  side: TeamSide;
  align?: 'right';
}) {
  const score = sideScore(challenge, side);
  const players = playersOf(challenge, side);
  const name = side === 'A' ? challenge.teamAName : challenge.teamBName;
  const style = SIDE_STYLE[side];
  const right = align === 'right';

  return (
    <div className={`min-w-0 flex-1 ${right ? 'text-right' : ''}`}>
      <div className={`flex items-center gap-1.5 ${right ? 'justify-end' : ''}`}>
        {players.slice(0, 3).map((m) => (
          <Avatar key={m.id} avatar={m.avatar} name={m.name} size={22} />
        ))}
        {players.length > 3 && (
          <span className="font-mono text-[10px] text-muted">+{players.length - 3}</span>
        )}
      </div>
      <p className="mt-1 truncate text-sm font-semibold text-ink">{name}</p>
      <p className={`font-mono text-lg font-bold ${style.text}`}>
        {score.net > 0 ? `+${score.net}` : score.net}
      </p>
      <p className="font-mono text-[9px] uppercase tracking-widest text-muted">
        {score.approved} ok · {score.rejected} missed
      </p>
    </div>
  );
}
