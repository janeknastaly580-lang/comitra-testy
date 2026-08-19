import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import * as api from '../lib/api';
import {
  CHAT_MAX_CHARS,
  fetchMessages,
  markThreadRead,
  sendMessage,
  type ChatMessage,
} from '../lib/chat';
import { shortDate, timeOfDay } from '../lib/format';
import { uuid } from '../lib/storage';
import { Avatar } from '../components/Avatar';
import PageHeader from '../components/PageHeader';
import { Button } from '../components/ui';

/**
 * How often an OPEN conversation checks for the other side's replies.
 *
 * There is no socket and no push service: this poll IS the delivery. While a
 * conversation is on screen it is the only thing the person is looking at, so it
 * runs fast — a few seconds, not the fifteen the conversation LIST uses. It
 * falls back to a slow beat once the page says it is hidden, and fires again the
 * instant it is looked at, so almost nothing is spent while nobody is reading.
 */
const POLL_MS = 3_000;

/**
 * The slowest this screen will ever go while it is still mounted.
 *
 * A page that says it is hidden gets the fast poll withheld — but not switched
 * off. Some WebViews (and every headless one) report themselves hidden while a
 * person is looking straight at them, and a conversation that quietly stops
 * updating is the exact bug this whole file exists to not have. So "hidden" buys
 * a long interval, never silence.
 */
const BACKGROUND_POLL_MS = 30_000;

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
 * WHO SENT IT IS NEVER LEFT TO BE INFERRED. Each of those three carries its
 * sender on its face: your own messages sit on the right, in the accent colour,
 * under "You"; theirs sit on the left behind their avatar, under their name; and
 * a request — the one kind that asks somebody to go and DO something — says
 * outright whether they asked you or you asked them. Being wrong about that
 * means accepting to judge a goal you thought you had set, so it is stated
 * rather than implied.
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
  /**
   * Messages typed here that the server has not handed back yet. They are drawn
   * straight away — waiting out a poll to see your own sentence appear is the
   * one delay a chat can never explain away — and drop out of this list as soon
   * as the same id arrives in a fetched one.
   */
  const [pending, setPending] = useState<ChatMessage[]>([]);
  const [profile, setProfile] = useState<api.SocialProfile | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  /** Set once the day's allowance is gone, so the composer stays honest. */
  const [outOfMessages, setOutOfMessages] = useState(false);
  /** True when the last attempt could not reach the server at all. */
  const [unreachable, setUnreachable] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  /** Keeps a slow poll from stacking on top of the one still in flight. */
  const fetching = useRef(false);

  const load = useCallback(
    async (markRead: boolean) => {
      if (!userId || !user || fetching.current) return;
      fetching.current = true;
      try {
        const list = await fetchMessages(userId);
        // The screen has had its first answer either way — leaving it on
        // "Loading…" forever because the network is down would be its own lie.
        setLoaded(true);
        // `null` is "we could not ask", which must never blank a conversation
        // somebody is reading. Only a real answer replaces what is on screen.
        if (!list) {
          setUnreachable(true);
          return;
        }
        setUnreachable(false);
        setMessages(list);
        setPending((p) => p.filter((m) => !list.some((row) => row.id === m.id)));
        if (markRead && list.some((m) => m.toUserId === user.id && !m.readAt)) {
          await markThreadRead(userId);
          await refreshChat();
        }
      } finally {
        fetching.current = false;
      }
    },
    [userId, user, refreshChat],
  );

  // The poll reads the loader out of a ref. Re-rendering happens here whenever
  // the conversation list changes underneath us, and an effect keyed on the
  // loader itself would tear the timer down and start a fresh one each time —
  // which, often enough, means it never lives long enough to fire at all.
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  }, [load]);

  useEffect(() => {
    if (!userId || !user) return;
    let stopped = false;
    let lastRun = 0;
    /**
     * `force` is what the mount and every wake-up use: they must fetch whatever
     * the page currently claims about its own visibility. Only the timer is
     * allowed to hold back, and only for a while — see BACKGROUND_POLL_MS.
     */
    const tick = (force: boolean) => {
      if (stopped) return;
      if (!force && document.hidden && Date.now() - lastRun < BACKGROUND_POLL_MS) return;
      lastRun = Date.now();
      void loadRef.current(true);
    };
    tick(true);
    const timer = setInterval(() => tick(false), POLL_MS);
    // Coming back to the app, or back onto a network, is the moment something is
    // most likely to be waiting: don't make anyone sit out the interval for it.
    const onWake = () => tick(true);
    document.addEventListener('visibilitychange', onWake);
    window.addEventListener('focus', onWake);
    window.addEventListener('online', onWake);
    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onWake);
      window.removeEventListener('focus', onWake);
      window.removeEventListener('online', onWake);
    };
  }, [userId, user]);

  useEffect(() => {
    if (!userId || !user) return;
    void (async () => {
      await api.hydratePeople(user.id, [userId]);
      setProfile(await api.getProfile(user.id, userId));
    })();
  }, [userId, user]);

  /** What is on screen: the server's list, plus anything still in flight. */
  const shown = useMemo(() => [...messages, ...pending], [messages, pending]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [shown.length]);

  if (!user || !userId) return null;

  async function send() {
    const text = draft.trim();
    if (!text || busy) return;
    setBusy(true);
    setNotice('');
    // The id is made here so that the copy drawn now and the copy the server
    // hands back are recognisably the same message, not two of them.
    const id = uuid();
    const optimistic: ChatMessage = {
      id,
      fromUserId: user!.id,
      toUserId: userId!,
      kind: 'text',
      body: text,
      payload: {},
      createdAt: new Date().toISOString(),
    };
    setPending((p) => [...p, optimistic]);
    setDraft('');
    try {
      const result = await sendMessage({ id, toUserId: userId!, text });
      if (result.sent) {
        await load(false);
      } else {
        // Nothing was stored, so take the bubble back and hand the person their
        // sentence back too, rather than leaving it looking sent.
        setPending((p) => p.filter((m) => m.id !== id));
        setDraft(text);
        if (result.reason === 'rate-limited') {
          // Said only now, after it happened — never as a warning up front.
          setOutOfMessages(true);
          setNotice("You've sent all your messages to this person for today. You can write again tomorrow.");
        } else {
          setNotice("That didn't send. Check your connection and try again.");
        }
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
        ) : shown.length === 0 ? (
          <p className="py-8 text-center text-[12px] text-muted">
            {unreachable
              ? "We couldn't reach the server, so this conversation isn't loaded yet."
              : 'No messages yet.'}
          </p>
        ) : (
          <div className="space-y-2.5">
            {shown.map((m) => (
              <Bubble
                key={m.id}
                message={m}
                mine={m.fromUserId === user.id}
                them={profile}
                sending={pending.some((p) => p.id === m.id)}
                onOpen={navigate}
              />
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

/** What a request asks for, worded the same way as the button that answers it. */
function requestWording(message: ChatMessage, goal: string): { what: string; action: string } {
  switch (message.payload.request) {
    case 'judge_invite':
      return { what: `be the judge of ${goal}`, action: 'Accept or decline' };
    case 'decision':
      return { what: `decide ${goal} now`, action: 'Decide this goal' };
    default:
      return { what: `allow a change to ${goal}`, action: 'Review the request' };
  }
}

/** Where a request's button leads, when it has one to lead anywhere. */
function targetFor(message: ChatMessage): string | null {
  const goalId = message.payload.goalId;
  if (!goalId || !message.payload.request) return null;
  return `/judge/${goalId}`;
}

function Bubble({
  message,
  mine,
  them,
  sending,
  onOpen,
}: {
  message: ChatMessage;
  mine: boolean;
  them: api.SocialProfile | null;
  sending: boolean;
  onOpen: (to: string) => void;
}) {
  const stamp = `${shortDate(message.createdAt)} · ${timeOfDay(message.createdAt)}`;
  // 'Someone' rather than a pronoun: a name that has not loaded yet still has to
  // sit in a sentence ("Someone is asking you to…") without reading as broken.
  const theirName = them?.name ?? 'Someone';

  if (message.kind === 'text') {
    if (mine) {
      return (
        <div className="flex justify-end">
          <div className="max-w-[82%]">
            <p className="mb-0.5 pr-1 text-right font-mono text-[9px] uppercase tracking-widest text-accent">
              You
            </p>
            <div className="rounded-2xl rounded-br-md bg-accent px-3.5 py-2 text-on-accent">
              <p className="whitespace-pre-wrap break-words text-sm">{message.body}</p>
              <p className="mt-0.5 text-right font-mono text-[9px] text-on-accent/75">
                {sending ? 'Sending…' : stamp}
              </p>
            </div>
          </div>
        </div>
      );
    }
    return (
      <div className="flex justify-start gap-2">
        <Avatar avatar={them?.avatar} name={theirName} size={26} className="mt-4" />
        <div className="max-w-[82%]">
          <p className="mb-0.5 pl-1 font-mono text-[9px] uppercase tracking-widest text-muted">
            {theirName}
          </p>
          <div className="rounded-2xl rounded-bl-md border border-line bg-elevated px-3.5 py-2 text-ink">
            <p className="whitespace-pre-wrap break-words text-sm">{message.body}</p>
            <p className="mt-0.5 text-right font-mono text-[9px] text-muted">{stamp}</p>
          </div>
        </div>
      </div>
    );
  }

  const goal = message.payload.goalNumber ? `goal #${message.payload.goalNumber}` : 'a goal';

  if (message.kind === 'request') {
    const { what, action } = requestWording(message, goal);
    const to = targetFor(message);

    // Incoming: somebody is asking YOU to go and do something. It gets their
    // name, their face, the accent colour, and the button that does it.
    if (!mine) {
      return (
        <div className="flex justify-start gap-2">
          <Avatar avatar={them?.avatar} name={theirName} size={26} className="mt-6" />
          {/* A plain div, not <Card>: Card carries its own background and border
              utilities, and Tailwind resolves those by stylesheet order rather
              than by the order they are written here — so a tint passed in
              through className simply loses. */}
          <div className="max-w-[88%] rounded-2xl border border-accent/60 bg-accent/10 p-3.5">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="rounded-full bg-accent px-2 py-0.5 font-mono text-[9px] uppercase tracking-widest text-on-accent">
                Request
              </span>
              <span className="font-mono text-[10px] uppercase tracking-widest text-accent">
                from {theirName}
              </span>
            </div>
            <p className="mt-2 text-sm text-ink">
              <span className="font-semibold">{theirName}</span> is asking you to {what}.
            </p>
            {to && (
              <Button className="mt-3 w-full" onClick={() => onOpen(to)}>
                {action}
              </Button>
            )}
            <p className="mt-1.5 font-mono text-[9px] text-muted">{stamp}</p>
          </div>
        </div>
      );
    }

    // Outgoing: you asked them. Deliberately quiet, and on your side of the
    // screen — there is nothing here for you to do, and it must not look as if
    // there were.
    return (
      <div className="flex justify-end">
        <div className="max-w-[88%] rounded-2xl border border-line bg-surface p-3.5">
          <div className="flex flex-wrap items-center justify-end gap-1.5">
            <span className="font-mono text-[10px] uppercase tracking-widest text-muted">Sent by you</span>
            <span className="rounded-full border border-line px-2 py-0.5 font-mono text-[9px] uppercase tracking-widest text-muted">
              Request
            </span>
          </div>
          <p className="mt-2 text-right text-sm text-ink">
            You asked <span className="font-semibold">{theirName}</span> to {what}.
          </p>
          <p className="mt-1.5 text-right font-mono text-[9px] text-muted">{stamp}</p>
        </div>
      </div>
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
      <span className="font-semibold text-ink">{mine ? 'You' : theirName}</span> {said} · {stamp}
    </p>
  );
}
