import type { TeamChallenge } from '../../lib/types';
import RelayTrack from './RelayTrack';
import TugOfWarBoard from './TugOfWarBoard';

/** Draws whichever board this challenge is being played on. */
export default function ChallengeBoard({ challenge }: { challenge: TeamChallenge }) {
  return challenge.mode === 'relay' ? (
    <RelayTrack challenge={challenge} />
  ) : (
    <TugOfWarBoard challenge={challenge} />
  );
}
