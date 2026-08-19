import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import * as api from '../lib/api';
import { chatPreview } from '../lib/chat';
import { shortDate, timeOfDay } from '../lib/format';
import { Avatar } from '../components/Avatar';
import PageHeader from '../components/PageHeader';
import { Badge, Card } from '../components/ui';

/**
 * Every conversation this account is in.
 *
 * The list is the server's (who you have actually exchanged messages with), and
 * the names come from the social graph on this device. A thread with somebody
 * the app cannot name still shows — hiding a message because a profile failed to
 * load would be worse than showing it without a name.
 */
export default function Messages() {
  const { user, chatThreads, refreshChat } = useApp();
  const navigate = useNavigate();
  const [people, setPeople] = useState<Record<string, api.SocialProfile>>({});
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    void (async () => {
      await refreshChat();
      setLoaded(true);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  useEffect(() => {
    if (!user) return;
    void (async () => {
      // A conversation can be with somebody this phone has never listed — the
      // judge of a goal, say. Fetch those names before building the list, or
      // half of it renders as "Someone".
      await api.hydratePeople(user.id, chatThreads.map((t) => t.userId));
      const profiles = await api.listProfiles(user.id);
      setPeople(Object.fromEntries(profiles.map((p) => [p.id, p])));
    })();
  }, [user, chatThreads]);

  if (!user) return null;

  return (
    <div className="px-4 py-5">
      <PageHeader title="Messages" back />

      {!loaded ? (
        <p className="py-10 text-center text-sm text-muted">Loading…</p>
      ) : chatThreads.length === 0 ? (
        <Card className="p-6 text-center">
          <p className="text-sm text-ink">No conversations yet.</p>
          <p className="mt-1 text-[12px] text-muted">
            Setting a goal with a judge starts one.
          </p>
        </Card>
      ) : (
        <div className="space-y-2">
          {chatThreads.map((thread) => {
            const person = people[thread.userId];
            return (
              <Card
                key={thread.userId}
                onClick={() => navigate(`/chat/${thread.userId}`)}
                className="flex items-center gap-3 p-3.5"
              >
                <Avatar avatar={person?.avatar} name={person?.name ?? '?'} size={40} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="truncate text-sm font-semibold text-ink">{person?.name ?? 'Someone'}</p>
                    {thread.unread > 0 && <Badge tone="accent">{thread.unread}</Badge>}
                  </div>
                  <p className="truncate text-[12px] text-muted">
                    {thread.lastFromUserId === user.id ? 'You: ' : ''}
                    {chatPreview({ kind: thread.lastKind, body: thread.lastBody, payload: {} })}
                  </p>
                </div>
                <p className="shrink-0 font-mono text-[10px] text-muted">
                  {shortDate(thread.lastAt)} · {timeOfDay(thread.lastAt)}
                </p>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
