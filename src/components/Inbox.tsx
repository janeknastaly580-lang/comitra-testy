import { useState } from 'react';
import { useApp } from '../context/AppContext';
import * as api from '../lib/api';
import { isVisible, pushBody, type PushMessage } from '../lib/push';
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
 * until it is answered, however long that takes.
 *
 * A consent request is ANSWERED here rather than on a link, because the consent
 * record itself lives in the asker's data — this device has nothing to open. The
 * yes or no travels back over the same channel (see `answerRecipientRequest`).
 */
export default function Inbox() {
  const { user, inbox, readMessage } = useApp();
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const unread = inbox.filter((m) => !m.readAt && isVisible(m));
  if (unread.length === 0) return null;

  async function answer(message: PushMessage, accepted: boolean) {
    if (!user) return;
    setBusy(message.id);
    setError('');
    try {
      await api.answerRecipientRequest({ message, answeringUserId: user.id, accepted });
      // Only now: an unread request is the only record that this is still open,
      // so it must not be cleared before the answer is safely on its way.
      await readMessage(message.id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy('');
    }
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

            {message.kind === 'recipient_consent_request' ? (
              <>
                <p className="mt-2 text-[11px] leading-relaxed text-muted">
                  You'd be told when one of their goals is not completed — its number, never what it is.
                  You can stop later.
                </p>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <Button
                    variant="outline"
                    disabled={busy === message.id}
                    onClick={() => answer(message, false)}
                  >
                    No thanks
                  </Button>
                  <Button disabled={busy === message.id} onClick={() => answer(message, true)}>
                    {busy === message.id ? 'Sending…' : 'I agree'}
                  </Button>
                </div>
              </>
            ) : (
              <Button variant="outline" className="mt-3 w-full" onClick={() => void readMessage(message.id)}>
                Got it
              </Button>
            )}
          </Card>
        ))}
      </div>
      {error && <p className="mt-2 font-mono text-xs text-danger">{error}</p>}
    </div>
  );
}
