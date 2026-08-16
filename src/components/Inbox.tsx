import { useNavigate } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import { pushBody, type PushMessage } from '../lib/push';
import { shortDate, timeOfDay } from '../lib/format';
import { Badge, Button, Card } from './ui';
import { Bell } from 'lucide-react';

/**
 * Everything a friend's goal has told this person.
 *
 * This is the visible half of `src/lib/push.ts`. On Android each message also
 * arrives as a system notification, but that banner is a courtesy — it can be
 * swiped away, refused at the permission prompt, or never shown because the app
 * was closed when it was sent. THIS list is the guarantee: a message stays here
 * until it is read, however long that takes.
 *
 * Only unread messages are shown. A consent request stays until it is answered
 * on the accept screen; a failure notice clears as soon as it is acknowledged,
 * because there is nothing to do about it but read it.
 */
export default function Inbox() {
  const { inbox, readMessage } = useApp();
  const navigate = useNavigate();

  const unread = inbox.filter((m) => !m.readAt);
  if (unread.length === 0) return null;

  /** Consent requests open the accept screen; everything else is just read. */
  function open(message: PushMessage) {
    const token = message.payload.consentToken;
    if (message.kind === 'recipient_consent_request' && token) {
      // Deliberately NOT marked read here: the request is answered on that
      // screen, and dismissing it on the way there would lose it for someone
      // who backs out. `acceptRecipientConsent` is what settles it.
      navigate(`/recipient/${token}`);
      return;
    }
    void readMessage(message.id);
  }

  return (
    <div className="mb-5">
      <h2 className="mb-2 flex items-center gap-2 font-mono text-xs uppercase tracking-widest text-muted">
        <Bell className="h-3.5 w-3.5" aria-hidden />
        For you
        <Badge tone="accent">{unread.length}</Badge>
      </h2>
      <div className="space-y-2">
        {unread.map((message) => (
          <Card key={message.id} className="p-4">
            <p className="text-sm leading-relaxed text-ink">{pushBody(message)}</p>
            <p className="mt-1 font-mono text-[10px] uppercase tracking-widest text-muted">
              {shortDate(message.createdAt)} · {timeOfDay(message.createdAt)}
            </p>
            <Button
              variant={message.kind === 'recipient_consent_request' ? 'primary' : 'outline'}
              className="mt-3 w-full"
              onClick={() => open(message)}
            >
              {message.kind === 'recipient_consent_request' ? 'See what they’re asking' : 'Got it'}
            </Button>
          </Card>
        ))}
      </div>
    </div>
  );
}
