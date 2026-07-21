import { useNavigate } from 'react-router-dom';
import { Button, Card, PremiumTag } from './ui';

/** Shown in place of a Premium-only screen when the user is on the free plan. */
export default function PremiumGate({ title, blurb }: { title: string; blurb: string }) {
  const navigate = useNavigate();
  return (
    <Card className="border-active/30 p-6 text-center">
      <div className="mb-2 flex justify-center">
        <PremiumTag />
      </div>
      <p className="text-lg font-bold text-ink">{title}</p>
      <p className="mt-1 text-sm text-muted">{blurb}</p>
      <Button className="mt-4 w-full" onClick={() => navigate('/premium')}>
        Unlock with Premium
      </Button>
    </Card>
  );
}
