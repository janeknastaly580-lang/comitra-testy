import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import * as api from '../lib/api';
import {
  CHAT_MAX_CHARS,
  listMessages,
  markThreadRead,
  sendMessage,
  type ChatMessage,
} from '../lib/chat';
import { shortDate, timeOfDay } from '../lib/format';
import { Avatar } from '../components/Avatar';
import PageHeader from '../components/PageHeader';
import { Button, Card } from '../components/ui';

/** How often an open conversation checks for the other side's replies. */
const POLL_MS = 12_000;

/**
 * One conversation.
 *
 * This is the channel that replaced every judge link. Three kinds of thing
 * appear in it and they are drawn differently on purpose:
 *
 *  • what the two people typed;
 *  • a REQUEST — "be my judge", "please decide this", "please cancel this" —
 *    which is a card with the button that does it, so the judge never has to go
 *    looking for where a message wants them to act;
 *  • an EVENT the app recorded, so the conversation is the goal's whole history.
 *
 * The limits (300 characters, 20 typed messages a day) are deliberately not
 * advertised. Nothing counts down at you; the composer simply stops at 300, and
 * if you run out of messages for the day it says so at the point where it
 * matters. Both are enforced server-side — this screen only words them.
 */
export default function Chat() {
  const { userId } = useParams();
  const { user, refreshChat } = useApp();
  const navigate = useNavigate();

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [profile, setProfile] = useState<api.SocialProfile | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  /** Set once the day's allowance is gone, so the composer stays honest. */
  const [outOfMessages, setOutOfMessages] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  const load = useCallback(
    async (markRead: boolean) => {
      if (!userId || !user) return;
      const list = await listMessages(userId);
      setMessages(list);
      setLoaded(true);
      if (markRead && list.some((m) => m.toUserId === user.id && !m.readAt)) {
        await markThreadRead(userId);
        await refreshChat();
      }
    },
    [userId, user, refreshChat],
  );

  useEffect(() => {
    void load(true);
    const timer = setInterval(() => void load(true), POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  useEffect(() => {
    if (!userId || !user) return;
    void (async () => {
      await api.hydratePeople(user.id, [userId]);
      setProfile(await api.getProfile(user.id, userId));
    })();
  }, [userId, user]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.length]);

  if (!user || !userId) return null;

  async function send() {
    const text = draft.trim();
    if (!text || busy) return;
    setBusy(true);
    setNotice('');
    try {
      const result = await sendMessage({ toUserId: userId!, text });
      if (result.sent) {
        setDraft('');
        await load(false);
      } else if (result.reason === 'rate-limited') {
        // Said only now, after it happened — never as a warning up front.
        setOutOfMessages(true);
        setNotice("You've sent all your messages to this person for today. You can write again tomorrow.");
      } else {
        setNotice("That didn't send. Check your connection and try again.");
      }
    } finally {
      setBusy(false);
    }
  }

  const name = profile?.name ?? 'Chat';

  return (
    <div className="flex h-full flex-col">
      <div className="px-4 pt-5">
        <PageHeader
          title={name}
          back
          action={profile ? <Avatar avatar={profile.avatar} name={profile.name} size={32} /> : undefined}
        />
      </div>

      <div className="flex-1 overflow-y-auto px-4 pb-2">
        {!loaded ? (
          <p className="py-8 text-center text-sm text-muted">Loading…</p>
        ) : messages.length === 0 ? (
          <p className="py-8 text-center text-[12px] text-muted">No messages yet.</p>
        ) : (
          <div className="space-y-2">
            {messages.map((m) => (
              <Bubble key={m.id} message={m} mine={m.fromUserId === user.id} onOpen={navigate} />
            ))}
          </div>
        )}
        <div ref={endRef} />
      </div>

      {notice && <p className="px-4 pb-1 text-[11px] text-warn">{notice}</p>}

      <div className="flex items-end gap-2 border-t border-line bg-surface px-4 py-3">
        <textarea
          rows={1}
          value={draft}
          disabled={outOfMessages}
          maxLength={CHAT_MAX_CHARS}
          onChange={(e) => setDraft(e.target.value.slice(0, CHAT_MAX_CHARS))}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder={outOfMessages ? 'No messages left today' : 'Message'}
          className="max-h-24 min-h-[42px] flex-1 resize-none rounded-xl border border-line bg-elevated px-3 py-2.5 text-sm text-ink outline-none transition placeholder:text-muted/60 focus:border-accent disabled:opacity-60"
        />
        <Button className="px-4 py-2.5" disabled={busy || outOfMessages || !draft.trim()} onClick={send}>
          Send
        </Button>
      </div>
    </div>
  );
}

/** What a request or an event says, and which button (if any) belongs on it. */
function actionFor(message: ChatMessage): { label: string; to: string } | null {
  const goalId = message.payload.goalId;
  if (!goalId) return null;
  if (message.payload.request) return { label: 'Open goal', to: `/judge/${goalId}` };
  return null;
}

function Bubble({
  message,
  mine,
  onOpen,
}: {
  message: ChatMessage;
  mine: boolean;
  onOpen: (to: string) => void;
}) {
  const stamp = `${shortDate(message.createdAt)} · ${timeOfDay(message.createdAt)}`;

  if (message.kind === 'text') {
    return (
      <div className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
        <div
          className={`max-w-[80%] rounded-2xl px-3.5 py-2 ${
            mine ? 'bg-accent/15 text-ink' : 'border border-line bg-elevated text-ink'
          }`}
        >
          <p className="whitespace-pre-wrap break-words text-sm">{message.body}</p>
          <p className="mt-0.5 text-right font-mono text-[9px] text-muted">{stamp}</p>
        </div>
      </div>
    );
  }

  const goal = message.payload.goalNumber ? `goal #${message.payload.goalNumber}` : 'a goal';
  const action = actionFor(message);

  if (message.kind === 'request') {
    const what =
      message.payload.request === 'judge_invite'
        ? `judge ${goal}`
        : message.payload.request === 'decision'
          ? `decide ${goal}`
          : `change or cancel ${goal}`;
    return (
      <Card className={`p-3.5 ${mine ? 'border-line' : 'border-accent/40 bg-accent/5'}`}>
        <p className="font-mono text-[10px] uppercase tracking-widest text-accent">
          {mine ? 'You asked' : 'Asked of you'}
        </p>
        <p className="mt-1 text-sm text-ink">
          {mine ? `You asked them to ${what}.` : `They asked you to ${what}.`}
        </p>
        {!mine && action && (
          <Button className="mt-3 w-full" onClick={() => onOpen(action.to)}>
            {action.label}
          </Button>
        )}
        <p className="mt-1.5 font-mono text-[9px] text-muted">{stamp}</p>
      </Card>
    );
  }

  const event = message.payload.event;
  const said =
    event === 'accepted'
      ? `accepted judging ${goal}`
      : event === 'declined'
        ? `declined judging ${goal}`
        : event === 'completed'
          ? `marked ${goal} completed`
          : event === 'not_completed'
            ? `marked ${goal} not completed`
            : `cancelled ${goal}`;

  return (
    <p className="py-1 text-center text-[11px] text-muted">
      {mine ? 'You' : 'They'} {said} · {stamp}
    </p>
  );
}
