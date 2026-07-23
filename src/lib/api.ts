/**
 * Mock API layer backed by LocalStorage — the MVP "database".
 *
 * This is the SOCIAL-COMMITMENT / SUBSCRIPTION model. There is no money,
 * deposit, stake, pot, token, wallet or reward anywhere. The only consequence
 * of a missed goal is an optional message to pre-approved recipients.
 *
 * Every function returns a Promise so the surface already looks like a real
 * async backend. To go live, re-implement this module against your server and
 * leave the React layer untouched.
 */
import { scheduleAppBlock, cancelAppBlock } from './appBlock';
import { MAX_INVITES_PER_DAY, MAX_RECIPIENTS_PER_GOAL, SUBSCRIPTION_PRICE_MONTHLY, TRIAL_MS } from './constants';
import { failureMessageForGoal, recipientInviteMessage } from './messages';
import { getDeviceId, KEYS, read, uid, uuid, write } from './storage';
import type {
  AbuseReport,
  AppBlockPenalty,
  AuditLog,
  Channel,
  FeatureRequest,
  FeatureRequestView,
  Goal,
  GoalEvidence,
  GoalJudge,
  GoalStatus,
  InvitedJudge,
  JudgeCredential,
  JudgeDecision,
  JudgeInvite,
  JudgeRating,
  League,
  LegalAcceptance,
  MessageTone,
  NotificationLog,
  OutboxMessage,
  PlanId,
  PlannedAction,
  RecipientConsent,
  Subscription,
  TesterApplication,
  TrainerClient,
  User,
} from './types';

const delay = (ms = 160) => new Promise((r) => setTimeout(r, ms));

/* ─────────────────────────────────────────────────── storage accessors ── */

function getUsers(): User[] {
  return read<User[]>(KEYS.users, []);
}
function saveUsers(users: User[]) {
  write(KEYS.users, users);
}
function getGoals(): Goal[] {
  return read<Goal[]>(KEYS.goals, []);
}
function saveGoals(goals: Goal[]) {
  write(KEYS.goals, goals);
}
function getConsents(): RecipientConsent[] {
  return read<RecipientConsent[]>(KEYS.recipientConsents, []);
}
function saveConsents(list: RecipientConsent[]) {
  write(KEYS.recipientConsents, list);
}
function getNotifications(): NotificationLog[] {
  return read<NotificationLog[]>(KEYS.notifications, []);
}
function saveNotifications(list: NotificationLog[]) {
  write(KEYS.notifications, list);
}

/* ───────────────────────────────────── Notification outbox ── */

function getOutbox(): OutboxMessage[] {
  return read<OutboxMessage[]>(KEYS.outbox, []);
}
function saveOutbox(list: OutboxMessage[]) {
  write(KEYS.outbox, list);
}

/**
 * Queue a message the system intends to deliver. On the MVP it is recorded here
 * (and surfaced in-app / via a share link); a real backend would deliver it by
 * push/SMS/email. Recipients must have consented before any `recipient_message`.
 */
function queueOutbox(msg: Omit<OutboxMessage, 'id' | 'createdAt' | 'status'> & { status?: OutboxMessage['status'] }): OutboxMessage {
  const list = getOutbox();
  const entry: OutboxMessage = {
    id: uid('out'),
    status: msg.status ?? 'queued',
    createdAt: new Date().toISOString(),
    ...msg,
  };
  list.unshift(entry);
  saveOutbox(list);
  return entry;
}

/** Messages queued for a goal (newest first) — used by the goal detail view. */
export async function listOutbox(goalId: string): Promise<OutboxMessage[]> {
  await delay(50);
  return getOutbox().filter((m) => m.goalId === goalId);
}

/** Compose the "please review this goal" message sent to the judge. */
function judgeReviewMessage(goal: Goal, reason: 'deadline' | 'early' | 'ready'): string {
  const who = goal.creatorName || 'Someone';
  const head =
    reason === 'deadline'
      ? `The deadline for ${who}'s goal has passed.`
      : reason === 'early'
        ? `${who} is asking you to decide their goal now, before the deadline.`
        : `${who} marked their goal ready and added proof.`;
  return `${head} Open your judge link to review the proof and mark it completed or not completed. You'll need your secret code.`;
}

/** Record a judge-review notification once per goal (no duplicates). */
function notifyJudgeReview(goal: Goal, reason: 'deadline' | 'early' | 'ready'): void {
  if (goal.noJudge) return;
  queueOutbox({
    goalId: goal.id,
    kind: 'judge_review_request',
    to: 'judge',
    channel: goal.judge.channel,
    contact: goal.judge.judgeContact,
    body: judgeReviewMessage(goal, reason),
  });
}

/* ──────────────────────────────────────────────────── audit / logging ── */

export function logAudit(entry: Omit<AuditLog, 'id' | 'createdAt'>): void {
  const logs = read<AuditLog[]>(KEYS.auditLogs, []);
  logs.push({ ...entry, id: uid('aud'), createdAt: new Date().toISOString() });
  write(KEYS.auditLogs, logs);
}

export function logLegalAcceptance(entry: Omit<LegalAcceptance, 'id' | 'acceptedAt'> & { acceptedAt?: string }): void {
  const logs = read<LegalAcceptance[]>(KEYS.legalAcceptances, []);
  logs.push({ ...entry, id: uid('legal'), acceptedAt: entry.acceptedAt ?? new Date().toISOString() });
  write(KEYS.legalAcceptances, logs);
}

export async function listAuditLogs(): Promise<AuditLog[]> {
  await delay(60);
  return read<AuditLog[]>(KEYS.auditLogs, []).sort(
    (a, b) => +new Date(b.createdAt) - +new Date(a.createdAt),
  );
}

/* ─────────────────────────────────────────────── subscription / trial ── */

function newTrialSubscription(startISO = new Date().toISOString()): Subscription {
  return {
    status: 'trialing',
    priceUsd: SUBSCRIPTION_PRICE_MONTHLY,
    provider: 'placeholder',
    trialStartedAt: startISO,
    trialEndsAt: new Date(+new Date(startISO) + TRIAL_MS).toISOString(),
  };
}

/**
 * True when the user may create/activate new goals — an active subscription OR a
 * trial that has not yet elapsed.
 */
export function hasEntitlement(user: User): boolean {
  const s = user.subscription;
  if (!s) return false;
  if (s.status === 'active') return true;
  if (s.status === 'trialing') return !!s.trialEndsAt && Date.now() < +new Date(s.trialEndsAt);
  return false;
}

/** Normalize a possibly-legacy user record to the new shape (non-destructive). */
function normalizeUser(user: User): User {
  let changed = false;
  const next: User = { ...user };

  // Migrate accounts created before the subscription model existed.
  if (!next.subscription) {
    next.subscription = newTrialSubscription(user.createdAt || new Date().toISOString());
    changed = true;
  }
  // Expire a lapsed trial.
  const s = next.subscription;
  if (s.status === 'trialing' && s.trialEndsAt && Date.now() >= +new Date(s.trialEndsAt)) {
    next.subscription = { ...s, status: 'expired' };
    changed = true;
  }

  // Keep the DEPRECATED plan/isPremium flags derived from entitlement so the
  // legacy "extras" (themes/leagues) keep working for subscribers.
  const entitled = hasEntitlement(next);
  const derivedPlan: PlanId = entitled ? 'premium' : 'free';
  if (next.plan !== derivedPlan || next.isPremium !== entitled) {
    next.plan = derivedPlan;
    next.isPremium = entitled;
    changed = true;
  }
  // One-time switch of the old green default to the new Cyberpunk Mint default.
  // Runs once per user, so anyone who later re-picks the green theme keeps it.
  if (next.theme === 'default' && !read(`theme:mintDefault:${user.id}`, false)) {
    next.theme = 'cyberpunk-mint';
    write(`theme:mintDefault:${user.id}`, true);
    changed = true;
  }
  // Backfill social fields for very old accounts.
  if (next.accountType === undefined) { next.accountType = 'standard'; changed = true; }
  if (next.following === undefined) { next.following = []; changed = true; }
  if (next.avatar === undefined) { next.avatar = 'preset-1'; changed = true; }
  if (next.bio === undefined) { next.bio = ''; changed = true; }
  if (next.isPrivate === undefined) { next.isPrivate = false; changed = true; }

  return changed ? persistUser(next) : next;
}

function persistUser(user: User): User {
  const users = getUsers().map((u) => (u.id === user.id ? user : u));
  saveUsers(users);
  return user;
}

/** Placeholder subscribe — swap for Stripe/RevenueCat/App Store/Play later. */
export async function subscribe(userId: string): Promise<User> {
  await delay();
  const user = getUsers().find((u) => u.id === userId);
  if (!user) throw new Error('User not found.');
  const now = new Date().toISOString();
  const subscription: Subscription = {
    status: 'active',
    priceUsd: SUBSCRIPTION_PRICE_MONTHLY,
    provider: 'placeholder',
    startedAt: now,
    currentPeriodEnd: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
    trialStartedAt: user.subscription?.trialStartedAt,
    trialEndsAt: user.subscription?.trialEndsAt,
  };
  logAudit({ actorId: userId, actionType: 'subscription_activated', entityType: 'user', entityId: userId, metadata: { priceUsd: SUBSCRIPTION_PRICE_MONTHLY } });
  return normalizeUser(persistUser({ ...user, subscription }));
}

export async function cancelSubscription(userId: string): Promise<User> {
  await delay();
  const user = getUsers().find((u) => u.id === userId);
  if (!user) throw new Error('User not found.');
  const subscription: Subscription = {
    ...user.subscription,
    status: 'cancelled',
    cancelledAt: new Date().toISOString(),
  };
  logAudit({ actorId: userId, actionType: 'subscription_cancelled', entityType: 'user', entityId: userId });
  return normalizeUser(persistUser({ ...user, subscription }));
}

/* ─────────────────────────────────────────────────────────────── Auth ── */

/** Shared blank-account shape used by register / guest / social sign-in. */
function blankUser(over: Partial<User> & Pick<User, 'id' | 'name' | 'email'>): User {
  const createdAt = new Date().toISOString();
  return {
    password: '',
    accountType: 'standard',
    subscription: newTrialSubscription(createdAt),
    plan: 'premium',
    isPremium: true,
    theme: 'cyberpunk-mint',
    createdAt,
    bio: '',
    avatar: 'preset-1',
    following: [],
    isPrivate: false,
    ...over,
  };
}

export async function register(
  name: string,
  email: string,
  password: string,
  accountType: 'standard' | 'trainer' = 'standard',
): Promise<User> {
  await delay();
  const users = getUsers();
  const normalized = email.trim().toLowerCase();
  if (users.some((u) => u.email === normalized && !u.deleted)) {
    throw new Error('An account with this email already exists.');
  }
  const user = blankUser({ id: uid('user'), name: name.trim() || 'Friend', email: normalized, password, accountType });
  users.push(user);
  saveUsers(users);
  write(KEYS.session, user.id);
  seedSocial(user.id);
  logAudit({ actorId: user.id, actionType: 'account_registered', entityType: 'user', entityId: user.id });
  return normalizeUser(getUsers().find((u) => u.id === user.id) ?? user);
}

export async function login(email: string, password: string): Promise<User> {
  await delay();
  const users = getUsers();
  const user = users.find((u) => u.email === email.trim().toLowerCase() && !u.deleted);
  if (!user || user.password !== password) throw new Error('Invalid email or password.');
  write(KEYS.session, user.id);
  seedSocial(user.id);
  return normalizeUser(getUsers().find((u) => u.id === user.id) ?? user);
}

export async function logout(): Promise<void> {
  await delay(80);
  write(KEYS.session, null);
}

export async function createGuest(): Promise<User> {
  const existing = await getSessionUser();
  if (existing?.isGuest) return existing;
  const users = getUsers();
  const user = blankUser({ id: uid('guest'), name: 'Guest', email: '', isGuest: true });
  users.push(user);
  saveUsers(users);
  write(KEYS.session, user.id);
  return user;
}

export async function socialLogin(profile: { email: string; name: string; avatar?: string }): Promise<User> {
  await delay(120);
  const email = profile.email.trim().toLowerCase();
  if (!email) throw new Error('No email address was returned by the provider.');
  const users = getUsers();
  const existing = users.find((u) => u.email === email && !u.deleted);
  if (existing) {
    write(KEYS.session, existing.id);
    seedSocial(existing.id);
    return normalizeUser(getUsers().find((u) => u.id === existing.id) ?? existing);
  }
  const user = blankUser({
    id: uid('user'),
    name: profile.name.trim() || email.split('@')[0],
    email,
    avatar: profile.avatar || 'preset-1',
  });
  users.push(user);
  saveUsers(users);
  write(KEYS.session, user.id);
  seedSocial(user.id);
  return normalizeUser(getUsers().find((u) => u.id === user.id) ?? user);
}

/** Fold a guest's goals into a real account after auth. */
export async function migrateGuest(guestId: string, targetId: string): Promise<void> {
  await delay(60);
  if (guestId === targetId) return;
  const users = getUsers();
  const guest = users.find((u) => u.id === guestId);
  const target = users.find((u) => u.id === targetId);
  if (!guest || !target) return;
  const goals = getGoals().map((g) =>
    g.userId === guestId
      ? { ...g, userId: targetId, creatorName: target.name, creatorAvatar: target.avatar }
      : g,
  );
  saveGoals(goals);
  // Re-home the guest's recipient consents to the real account.
  const consents = getConsents().map((c) =>
    c.ownerUserId === guestId ? { ...c, ownerUserId: targetId } : c,
  );
  saveConsents(consents);
  saveUsers(users.filter((u) => u.id !== guestId));
}

export async function deleteAccount(userId: string): Promise<void> {
  await delay();
  saveUsers(getUsers().map((u) => (u.id === userId ? { ...u, deleted: true } : u)));
  write(KEYS.session, null);
  logAudit({ actorId: userId, actionType: 'account_deleted', entityType: 'user', entityId: userId });
}

export async function getSessionUser(): Promise<User | null> {
  const id = read<string | null>(KEYS.session, null);
  if (!id) return null;
  const user = getUsers().find((u) => u.id === id) ?? null;
  return user ? normalizeUser(user) : null;
}

export async function updateUser(user: User): Promise<User> {
  await delay(80);
  return normalizeUser(persistUser(user));
}

/* ───────────────────────────────────────────────────── Goal lifecycle ── */

export async function listGoals(userId: string): Promise<Goal[]> {
  await delay(80);
  resolveExpired();
  return getGoals()
    .filter((g) => g.userId === userId)
    .sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
}

export async function getGoal(id: string): Promise<Goal | null> {
  resolveExpired();
  return getGoals().find((g) => g.id === id) ?? null;
}

export async function getGoalByToken(token: string): Promise<Goal | null> {
  resolveExpired();
  return getGoals().find((g) => g.shareToken === token || g.judge.acceptToken === token) ?? null;
}

export interface RecipientInput {
  name: string;
  channel: Channel;
  contact?: string; // email / phone
  recipientUserId?: string; // internal profile
}

export interface CreateGoalInput {
  userId: string;
  creatorName: string;
  creatorAvatar?: string;
  title: string;
  description: string;
  requiredActionsCount: number;
  startsAt?: string; // ISO
  deadlineAt: string; // ISO
  messageTone: MessageTone;
  includeGoalTitleInFailureMessage: boolean;
  includeGoalDescriptionInFailureMessage: boolean;
  ackNotifyConsent: boolean;
  ackRevealFullContent?: boolean;
  /** The user agrees the judge will see the goal's title + details. */
  ackJudgeSeesContent?: boolean;
  /** Omit the judge entirely to create a solo (self-tracked) goal. */
  judge?: { name: string; channel: Channel; contact?: string; judgeUserId?: string };
  recipients: RecipientInput[];
  /** Solo-goal penalty: block an app for a while if the goal is missed. */
  appBlock?: AppBlockPenalty;
}

/** Build the planned steps for a new goal. */
function buildPlannedActions(input: CreateGoalInput): PlannedAction[] {
  const now = new Date().toISOString();
  const n = Math.max(1, input.requiredActionsCount || 1);
  return Array.from({ length: n }, (_, i) => ({
    id: uid('pa'),
    actionType: 'step',
    actionName: `Step ${i + 1}`,
    status: 'planned',
    createdAt: now,
    updatedAt: now,
  }));
}

function normalizeContact(channel: Channel, raw?: string): string | undefined {
  if (!raw) return undefined;
  return channel === 'phone' ? normalizePhone(raw) : raw.trim().toLowerCase();
}

export function normalizePhone(raw: string): string {
  const trimmed = raw.trim();
  const hasPlus = trimmed.startsWith('+');
  return (hasPlus ? '+' : '') + trimmed.replace(/\D/g, '');
}

/** How many recipient invites this owner has sent in the last 24h. */
function invitesSentToday(ownerUserId: string): number {
  const since = Date.now() - 24 * 3600 * 1000;
  return getConsents().filter(
    (c) => c.ownerUserId === ownerUserId && +new Date(c.createdAt) >= since,
  ).length;
}

/**
 * Find an existing consent for this owner+recipient, or create a pending one
 * (with an invite). Returns the consent. Reuses standing consent so a recipient
 * who already accepted for this owner does not need to re-accept.
 */
function upsertConsent(ownerUserId: string, r: RecipientInput): RecipientConsent {
  const contact = normalizeContact(r.channel, r.contact);
  const consents = getConsents();
  const existing = consents.find(
    (c) =>
      c.ownerUserId === ownerUserId &&
      c.channel === r.channel &&
      ((contact && c.recipientContact === contact) ||
        (r.recipientUserId && c.recipientUserId === r.recipientUserId)),
  );
  if (existing) {
    // Reactivate a lapsed record's name; do NOT silently un-revoke consent.
    if (existing.name !== r.name.trim() && r.name.trim()) {
      existing.name = r.name.trim();
      saveConsents(consents);
    }
    return existing;
  }
  const consent: RecipientConsent = {
    id: uid('rc'),
    ownerUserId,
    name: r.name.trim() || 'Recipient',
    channel: r.channel,
    recipientContact: contact,
    recipientUserId: r.recipientUserId,
    consentStatus: 'pending',
    inviteToken: uuid(),
    createdAt: new Date().toISOString(),
  };
  consents.push(consent);
  saveConsents(consents);
  logAudit({ actorId: ownerUserId, actionType: 'recipient_invited', entityType: 'recipient_consent', entityId: consent.id, metadata: { channel: consent.channel } });
  // Notification #1: ask the recipient to consent BEFORE any message is ever sent.
  const owner = getUsers().find((u) => u.id === ownerUserId);
  queueOutbox({
    kind: 'recipient_consent_request',
    to: 'recipient',
    channel: consent.channel,
    contact: consent.recipientContact,
    body: recipientInviteMessage(owner?.name ?? 'A Comitra user'),
  });
  return consent;
}

/**
 * Create + submit a goal. Requires an active subscription or live trial. Invites
 * the judge and each recipient (reusing standing consents). Never activates
 * until the judge accepts AND every recipient has an accepted consent.
 */
export async function createGoal(input: CreateGoalInput): Promise<Goal> {
  await delay();
  const owner = getUsers().find((u) => u.id === input.userId);
  if (!owner) throw new Error('User not found.');
  if (!hasEntitlement(normalizeUser(owner))) {
    throw new Error('A subscription is required to create goals.');
  }
  const recips = input.recipients.filter((r) => r.name.trim() || r.contact || r.recipientUserId);
  // Recipients are optional now — but if there are any, the notify consent is required.
  if (recips.length > 0 && !input.ackNotifyConsent) {
    throw new Error('You must acknowledge that recipients may be messaged on failure.');
  }
  if (recips.length > MAX_RECIPIENTS_PER_GOAL) {
    throw new Error(`You can add at most ${MAX_RECIPIENTS_PER_GOAL} recipients.`);
  }
  if (input.judge && !input.ackJudgeSeesContent) {
    throw new Error('You must agree that your judge will see the goal’s title and details.');
  }
  // Anti-spam: count how many of these are brand-new invites.
  const newInvites = recips.filter((r) => {
    const contact = normalizeContact(r.channel, r.contact);
    return !getConsents().some(
      (c) =>
        c.ownerUserId === input.userId &&
        ((contact && c.recipientContact === contact) ||
          (r.recipientUserId && c.recipientUserId === r.recipientUserId)),
    );
  }).length;
  if (invitesSentToday(input.userId) + newInvites > MAX_INVITES_PER_DAY) {
    throw new Error(`Daily invite limit reached (${MAX_INVITES_PER_DAY}/day). Try again tomorrow.`);
  }

  const consents = recips.map((r) => upsertConsent(input.userId, r));

  const noJudge = !input.judge;
  const judge: GoalJudge = input.judge
    ? {
        name: input.judge.name.trim() || 'Judge',
        channel: input.judge.channel,
        judgeContact: normalizeContact(input.judge.channel, input.judge.contact),
        judgeUserId: input.judge.judgeUserId,
        status: 'pending',
        acceptToken: uuid(),
      }
    : {
        // Solo goal: a placeholder judge that is already "accepted" so the goal
        // can activate immediately. The creator tracks and completes it alone.
        name: 'No judge',
        channel: 'internal',
        status: 'accepted',
        acceptedAt: new Date().toISOString(),
        acceptToken: uuid(),
      };

  // Standing acceptance: if THIS owner has already had this judge accept a role
  // (and set a code), the judge does not need to re-consent — pre-accept them.
  if (input.judge) {
    const standing = findJudgeCredential(input.userId, judgeKeyFor(judge));
    if (standing) {
      judge.status = 'accepted';
      judge.acceptedAt = new Date().toISOString();
      judge.codeSet = true;
      if (standing.judgeAccountUserId) judge.judgeAccountUserId = standing.judgeAccountUserId;
    }
  }

  const goal: Goal = {
    id: uuid(),
    userId: input.userId,
    creatorName: input.creatorName.trim() || 'Someone',
    creatorAvatar: input.creatorAvatar,
    creatorDeviceId: getDeviceId(),
    title: input.title.trim(),
    description: input.description.trim(),
    requiredActionsCount: Math.max(1, input.requiredActionsCount || 1),
    plannedActions: buildPlannedActions(input),
    startsAt: input.startsAt,
    deadlineAt: input.deadlineAt,
    status: 'waiting_for_judge_acceptance',
    messageTone: input.messageTone,
    includeGoalTitleInFailureMessage: input.includeGoalTitleInFailureMessage,
    includeGoalDescriptionInFailureMessage: input.includeGoalDescriptionInFailureMessage,
    ackNotifyConsent: input.ackNotifyConsent,
    ackRevealFullContent: input.ackRevealFullContent,
    ackJudgeSeesContent: input.ackJudgeSeesContent,
    noJudge,
    appBlock: noJudge ? input.appBlock : undefined,
    evidence: [],
    judge,
    recipients: consents.map((c) => ({ consentId: c.id })),
    shareToken: judge.acceptToken,
    createdAt: new Date().toISOString(),
  };

  const goals = getGoals();
  goals.push(recompute(goal));
  saveGoals(goals);

  // Notification #2: ask the chosen judge to accept the role (unless pre-accepted).
  if (input.judge && judge.status !== 'accepted') {
    queueOutbox({
      goalId: goal.id,
      kind: 'judge_invite',
      to: 'judge',
      channel: judge.channel,
      contact: judge.judgeContact,
      body: `${goal.creatorName} asks you to be the judge for their goal. Open your judge link to accept the role, set your secret code, and later decide the outcome.`,
    });
  }

  if (recips.length > 0) {
    logLegalAcceptance({ type: 'goal_notify_ack', userId: input.userId, goalId: goal.id });
  }
  if (input.ackRevealFullContent) {
    logLegalAcceptance({ type: 'goal_reveal_full_content_ack', userId: input.userId, goalId: goal.id });
  }
  logAudit({ actorId: input.userId, actionType: 'goal_created', entityType: 'goal', entityId: goal.id, metadata: { tone: goal.messageTone, recipients: consents.length } });
  return getGoals().find((g) => g.id === goal.id)!;
}

/** Recompute a pre-active goal's status from judge + recipient acceptance. */
function recompute(goal: Goal): Goal {
  if (!['waiting_for_judge_acceptance', 'waiting_for_recipients_acceptance', 'draft'].includes(goal.status)) {
    return goal;
  }
  if (goal.judge.status !== 'accepted') {
    return { ...goal, status: 'waiting_for_judge_acceptance' };
  }
  // With no recipients the goal activates as soon as the judge accepts (or
  // immediately, for a solo goal). Otherwise it also needs at least one accepted
  // recipient; any non-responding recipient is simply skipped at send time.
  const activate = (): Goal => ({ ...goal, status: 'active', activatedAt: goal.activatedAt ?? new Date().toISOString() });
  if (goal.recipients.length === 0) return activate();
  const consents = getConsents();
  const anyAccepted = goal.recipients.some((r) => {
    const c = consents.find((x) => x.id === r.consentId);
    return c && c.consentStatus === 'accepted';
  });
  if (!anyAccepted) return { ...goal, status: 'waiting_for_recipients_acceptance' };
  return activate();
}

function reevaluateGoals(predicate: (g: Goal) => boolean) {
  const goals = getGoals().map((g) => (predicate(g) ? recompute(g) : g));
  saveGoals(goals);
}

/**
 * Add proof of completion. Links the proof to a planned step — the one given, or
 * otherwise the next open step — and advances that step's status. Updates
 * progress via the count of evidence items.
 */
export async function addEvidence(
  goalId: string,
  evidence: Omit<GoalEvidence, 'id' | 'addedAt'>,
): Promise<Goal> {
  await delay();
  const goals = getGoals();
  const goal = goals.find((g) => g.id === goalId);
  if (!goal) throw new Error('Goal not found.');
  const now = new Date().toISOString();
  const item: GoalEvidence = { ...evidence, id: uid('ev'), addedAt: now };

  // Attach to a planned step: the chosen one, else the next open one.
  let paId = evidence.plannedActionId;
  if (!paId) {
    paId = goal.plannedActions.find(
      (p) => p.status === 'planned' || p.status === 'rescheduled',
    )?.id;
  }
  if (paId) {
    goal.plannedActions = goal.plannedActions.map((p) =>
      p.id === paId ? { ...p, status: 'evidence_added', evidenceId: item.id, updatedAt: now } : p,
    );
    item.plannedActionId = paId;
  }

  const firstProof = goal.evidence.length === 0;
  goal.evidence = [item, ...goal.evidence];
  saveGoals(goals);
  // Notify the judge when the user first marks progress (adds proof).
  if (firstProof && !goal.noJudge) notifyJudgeReview(goal, 'ready');
  logAudit({ actorId: goal.userId, actionType: 'evidence_added', entityType: 'goal', entityId: goal.id, metadata: { type: item.type } });
  return goal;
}

/** Update a planned action's status (mark skipped / rest / planned). */
export async function updatePlannedAction(
  goalId: string,
  actionId: string,
  status: PlannedAction['status'],
): Promise<Goal> {
  await delay(60);
  const goals = getGoals();
  const goal = goals.find((g) => g.id === goalId);
  if (!goal) throw new Error('Goal not found.');
  goal.plannedActions = goal.plannedActions.map((p) =>
    p.id === actionId ? { ...p, status, updatedAt: new Date().toISOString() } : p,
  );
  saveGoals(goals);
  return goal;
}

/** Non-terminal statuses a goal can still be cancelled from. */
const CANCELLABLE_STATUSES: GoalStatus[] = [
  'draft',
  'waiting_for_judge_acceptance',
  'waiting_for_recipients_acceptance',
  'active',
  'proof_pending',
  'judge_review',
];

export async function cancelGoal(goalId: string): Promise<Goal> {
  await delay();
  const goals = getGoals();
  const goal = goals.find((g) => g.id === goalId);
  if (!goal) throw new Error('Goal not found.');
  // ONLY a solo (judge-less) goal can be cancelled by the creator. A goal that
  // has a judge — even before it starts — is cancelled by that judge, once the
  // creator asks them. See requestCancel / judgeCancelGoal.
  if (!goal.noJudge) {
    throw new Error('A goal with a judge can only be cancelled by the judge, once you ask them to.');
  }
  if (!CANCELLABLE_STATUSES.includes(goal.status)) throw new Error('This goal cannot be cancelled now.');
  goal.status = 'cancelled';
  goal.cancelledAt = new Date().toISOString();
  saveGoals(goals);
  cancelAppBlock(goal.id); // solo goal cancelled in time → no penalty
  logAudit({ actorId: goal.userId, actionType: 'goal_cancelled', entityType: 'goal', entityId: goal.id });
  return goal;
}

/**
 * The creator asks their judge to cancel a running goal (they can't cancel a
 * judged goal themselves). Notifies the judge; the judge can only cancel after
 * this. No secret code is involved in cancelling.
 */
export async function requestCancel(goalId: string, userId: string): Promise<Goal> {
  await delay(80);
  const goals = getGoals();
  const goal = goals.find((g) => g.id === goalId);
  if (!goal) throw new Error('Goal not found.');
  if (goal.userId !== userId) throw new Error('Only the goal owner can ask to cancel.');
  if (goal.noJudge) throw new Error('This goal has no judge — you can cancel it yourself.');
  if (!CANCELLABLE_STATUSES.includes(goal.status)) throw new Error('This goal cannot be cancelled now.');
  goal.cancelRequested = true;
  saveGoals(goals);
  queueOutbox({
    goalId: goal.id,
    kind: 'judge_review_request',
    to: 'judge',
    channel: goal.judge.channel,
    contact: goal.judge.judgeContact,
    body: `${goal.creatorName} asks you to cancel their goal. Open your judge link and cancel it — no code needed.`,
  });
  logAudit({ actorId: userId, actionType: 'cancel_requested', entityType: 'goal', entityId: goal.id });
  return goal;
}

/** Creator marks their own solo (judge-less) goal as completed. */
export async function completeSoloGoal(goalId: string, userId: string): Promise<Goal> {
  await delay();
  const goals = getGoals();
  const goal = goals.find((g) => g.id === goalId);
  if (!goal) throw new Error('Goal not found.');
  if (goal.userId !== userId) throw new Error('Only the goal owner can complete this goal.');
  if (!goal.noJudge) throw new Error('This goal has a judge — only the judge can decide it.');
  if (goal.status !== 'active') throw new Error('Only an active goal can be marked completed.');
  const at = new Date().toISOString();
  goal.status = 'completed';
  goal.completedAt = at;
  goal.judge = { ...goal.judge, decision: 'completed', decisionAt: at };
  saveGoals(goals);
  cancelAppBlock(goal.id); // completed in time → no penalty
  logAudit({ actorId: userId, actionType: 'solo_goal_completed', entityType: 'goal', entityId: goal.id });
  return goal;
}

/**
 * The creator asks their judge to decide the goal before the deadline. This is
 * the ONLY way a judge may decide early. Notifies the judge.
 */
export async function requestEarlyDecision(goalId: string, userId: string): Promise<Goal> {
  await delay(80);
  const goals = getGoals();
  const goal = goals.find((g) => g.id === goalId);
  if (!goal) throw new Error('Goal not found.');
  if (goal.userId !== userId) throw new Error('Only the goal owner can request an early decision.');
  if (goal.noJudge) throw new Error('This goal has no judge.');
  if (goal.status !== 'active') throw new Error('You can only ask for an early decision while the goal is active.');
  goal.earlyDecisionRequested = true;
  saveGoals(goals);
  notifyJudgeReview(goal, 'early');
  logAudit({ actorId: userId, actionType: 'early_decision_requested', entityType: 'goal', entityId: goal.id });
  return goal;
}

const DELETABLE: GoalStatus[] = ['completed', 'failed_notified', 'cancelled', 'expired_without_judge_decision'];
export async function deleteGoal(id: string): Promise<void> {
  await delay(80);
  const goal = getGoals().find((g) => g.id === id);
  if (!goal) return;
  if (!DELETABLE.includes(goal.status)) {
    throw new Error('Only finished goals can be removed from history.');
  }
  saveGoals(getGoals().filter((g) => g.id !== id));
}

/** Move active goals past their deadline into proof/decision, and expire stale ones. */
function resolveExpired() {
  const now = Date.now();
  const goals = getGoals();
  let changed = false;
  for (const g of goals) {
    if (g.status === 'active' && now > +new Date(g.deadlineAt)) {
      if (g.noJudge) {
        // Solo goal missed → apply the app-block penalty (blocks the chosen app
        // for `durationMinutes` starting now). See src/lib/appBlock.ts.
        g.status = 'failed_notified';
        g.failedAt = new Date().toISOString();
        if (g.appBlock) {
          const untilMs = now + g.appBlock.durationMinutes * 60_000;
          g.appBlockUntil = new Date(untilMs).toISOString();
          scheduleAppBlock(g.id, g.appBlock.packageName, g.appBlock.appLabel, untilMs);
        }
      } else {
        // Judged goal past its deadline → wait for the judge and notify them.
        g.status = 'proof_pending';
        if (!g.judgeReviewNotifiedAt) {
          g.judgeReviewNotifiedAt = new Date().toISOString();
          notifyJudgeReview(g, 'deadline');
        }
      }
      changed = true;
    }
    // If the judge never decides within 30 days after the deadline, expire it.
    const graceEnd = +new Date(g.deadlineAt) + 30 * 24 * 3600 * 1000;
    if ((g.status === 'proof_pending' || g.status === 'judge_review') && now > graceEnd) {
      g.status = 'expired_without_judge_decision';
      changed = true;
    }
  }
  if (changed) saveGoals(goals);
}

/* ─────────────────────────────────── Judge codes / credentials ── */

function getJudgeCredentials(): JudgeCredential[] {
  return read<JudgeCredential[]>(KEYS.judgeCredentials, []);
}
function saveJudgeCredentials(list: JudgeCredential[]) {
  write(KEYS.judgeCredentials, list);
}

/** Minimum length of a judge's secret verification code. */
export const JUDGE_CODE_MIN = 4;

/** Non-cryptographic hash so codes are never stored in the clear (MVP only). */
function hashCode(code: string): string {
  const s = `comitra:judge:${code.trim()}`;
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return `h${(h >>> 0).toString(36)}`;
}

/** Stable identity of a judge for one owner (account id, else contact). */
function judgeKeyFor(judge: Pick<GoalJudge, 'judgeUserId' | 'judgeContact'>): string {
  if (judge.judgeUserId) return `u:${judge.judgeUserId}`;
  if (judge.judgeContact) return `c:${judge.judgeContact}`;
  return '';
}

function findJudgeCredential(ownerUserId: string, judgeKey: string): JudgeCredential | undefined {
  if (!judgeKey) return undefined;
  return getJudgeCredentials().find((c) => c.ownerUserId === ownerUserId && c.judgeKey === judgeKey);
}

/** Create or update a judge's standing credential (acceptance + code) for an owner. */
function upsertJudgeCredential(ownerUserId: string, judgeKey: string, code: string, judgeAccountUserId?: string): void {
  if (!judgeKey) return;
  const list = getJudgeCredentials();
  const existing = list.find((c) => c.ownerUserId === ownerUserId && c.judgeKey === judgeKey);
  if (existing) {
    existing.codeHash = hashCode(code);
    if (judgeAccountUserId) existing.judgeAccountUserId = judgeAccountUserId;
  } else {
    list.push({ id: uid('jc'), ownerUserId, judgeKey, codeHash: hashCode(code), judgeAccountUserId, createdAt: new Date().toISOString() });
  }
  saveJudgeCredentials(list);
}

/** Whether this owner has an existing standing acceptance for this judge. */
export function hasStandingJudgeAcceptance(ownerUserId: string, judge: Pick<GoalJudge, 'judgeUserId' | 'judgeContact'>): boolean {
  return !!findJudgeCredential(ownerUserId, judgeKeyFor(judge));
}

/* ─────────────────────────── Invite friends as judges ── */

function getJudgeInvites(): JudgeInvite[] {
  return read<JudgeInvite[]>(KEYS.judgeInvites, []);
}
function getInvitedJudges(): InvitedJudge[] {
  return read<InvitedJudge[]>(KEYS.invitedJudges, []);
}

/**
 * The identity an invite link carries in itself. Because everything the judge
 * needs is embedded here (not looked up in the inviter's LocalStorage), the link
 * opens on ANY device — this is what makes cross-device invites work without a
 * shared backend. `d` (the inviter's device id) also powers the "accept from a
 * different device" anti-cheat check.
 */
interface JudgeInvitePayload {
  v: 1;
  t: string; // reusable invite token (per owner)
  o: string; // ownerUserId
  n: string; // owner display name (fallback when the owner isn't on this device)
  d: string; // inviter device id
}

/** UTF-8-safe base64url so owner names with accents survive the round-trip. */
function b64urlEncode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(s: string): string {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
function encodeInvitePayload(p: JudgeInvitePayload): string {
  return b64urlEncode(JSON.stringify(p));
}
function decodeInvitePayload(token: string): JudgeInvitePayload | null {
  try {
    const p = JSON.parse(b64urlDecode(token)) as JudgeInvitePayload;
    return p && p.v === 1 && p.o ? p : null;
  } catch {
    return null;
  }
}

/**
 * Get (or create) the owner's reusable invite token and return a **self-contained
 * link token** that embeds who is inviting + which device generated it, so the
 * link resolves on any device the friend opens it on.
 */
export async function getOrCreateJudgeInvite(
  ownerUserId: string,
): Promise<JudgeInvite & { inviteToken: string }> {
  await delay(60);
  const list = getJudgeInvites();
  const deviceId = getDeviceId();
  let invite = list.find((i) => i.ownerUserId === ownerUserId);
  if (invite) {
    // Backfill the inviter device on older invites so the device check works.
    if (!invite.inviterDeviceId) {
      invite.inviterDeviceId = deviceId;
      write(KEYS.judgeInvites, list);
    }
  } else {
    invite = { ownerUserId, token: uuid(), inviterDeviceId: deviceId, createdAt: new Date().toISOString() };
    list.push(invite);
    write(KEYS.judgeInvites, list);
  }
  const owner = getUsers().find((u) => u.id === ownerUserId);
  const inviteToken = encodeInvitePayload({
    v: 1,
    t: invite.token,
    o: ownerUserId,
    n: owner?.name ?? 'A Comitra user',
    d: invite.inviterDeviceId ?? deviceId,
  });
  return { ...invite, inviteToken };
}

/** What the public accept page can resolve from an invite token. */
export interface JudgeInviteInfo {
  ownerName: string;
  ownerUserId: string;
  /** True when opened on the same device that generated the link (must be blocked). */
  sameDevice: boolean;
}

/** Resolve an invite token to the inviting owner (for the public accept page). */
export async function getJudgeInvite(token: string): Promise<JudgeInviteInfo | null> {
  await delay(60);
  const payload = decodeInvitePayload(token);
  if (payload) {
    // Self-contained link — valid on any device.
    const owner = getUsers().find((u) => u.id === payload.o);
    return {
      ownerName: owner?.name ?? payload.n ?? 'A Comitra user',
      ownerUserId: payload.o,
      sameDevice: !!payload.d && getDeviceId() === payload.d,
    };
  }
  // Legacy raw token (same-browser only).
  const invite = getJudgeInvites().find((i) => i.token === token);
  if (!invite) return null;
  const owner = getUsers().find((u) => u.id === invite.ownerUserId);
  return {
    ownerName: owner?.name ?? 'A Comitra user',
    ownerUserId: invite.ownerUserId,
    sameDevice: !!invite.inviterDeviceId && getDeviceId() === invite.inviterDeviceId,
  };
}

/** Resolve the inviting owner (+ device) for a token, self-contained or legacy. */
function resolveInvite(token: string): { ownerUserId: string; inviterDeviceId?: string } | null {
  const payload = decodeInvitePayload(token);
  if (payload) return { ownerUserId: payload.o, inviterDeviceId: payload.d };
  const invite = getJudgeInvites().find((i) => i.token === token);
  if (!invite) return null;
  return { ownerUserId: invite.ownerUserId, inviterDeviceId: invite.inviterDeviceId };
}

/**
 * The friend submits the invite form: their name, phone and judge password, and
 * consents to Comitra messages about this owner's goals. This registers them as
 * a pickable judge for that owner and stores their standing acceptance + password.
 * The name must be unique among this owner's judges, and the link must be opened
 * on a different device than the one that created it.
 */
export async function submitJudgeInvite(
  token: string,
  input: { name: string; phone: string; code: string },
): Promise<InvitedJudge> {
  await delay();
  const invite = resolveInvite(token);
  if (!invite) throw new Error('This invite link is not valid.');
  // Anti-cheat: the inviter must not register as their own judge from their device.
  if (invite.inviterDeviceId && getDeviceId() === invite.inviterDeviceId) {
    throw new Error('Open this invite on a different device than the one that created it.');
  }
  const phone = normalizePhone(input.phone);
  if (phone.replace(/\D/g, '').length < 7) throw new Error('Enter a valid phone number.');
  const code = (input.code ?? '').trim();
  if (code.length < JUDGE_CODE_MIN) throw new Error(`Set a judge password of at least ${JUDGE_CODE_MIN} characters.`);
  const name = input.name.trim();
  if (name.length < 2) throw new Error('Enter your name (at least 2 characters).');

  const list = getInvitedJudges();
  const now = new Date().toISOString();
  // The name must be unique among this owner's judges (a different person can't
  // reuse a name already taken for this owner).
  const nameKey = name.toLowerCase();
  const nameTaken = list.some(
    (j) => j.ownerUserId === invite.ownerUserId && j.name.trim().toLowerCase() === nameKey && j.phone !== phone,
  );
  if (nameTaken) {
    throw new Error('That name is already used by one of this person’s judges. Please choose a different name.');
  }

  let record = list.find((j) => j.ownerUserId === invite.ownerUserId && j.phone === phone);
  if (record) {
    record.name = name;
    record.consentedAt = now;
  } else {
    record = { id: uid('ij'), ownerUserId: invite.ownerUserId, name, phone, consentedAt: now, createdAt: now };
    list.push(record);
  }
  write(KEYS.invitedJudges, list);

  // Store the standing acceptance + judge password for this owner+judge.
  upsertJudgeCredential(invite.ownerUserId, judgeKeyFor({ judgeContact: phone }), code);
  logLegalAcceptance({ type: 'judge_role_ack', contact: phone, meta: { ownerUserId: invite.ownerUserId, source: 'invite' } });
  logAudit({ actorContact: phone, actionType: 'judge_invite_accepted', entityType: 'user', entityId: invite.ownerUserId });
  return record;
}

/** Friends the owner invited who can be picked as a judge. */
export async function listInvitedJudges(ownerUserId: string): Promise<InvitedJudge[]> {
  await delay(60);
  return getInvitedJudges()
    .filter((j) => j.ownerUserId === ownerUserId)
    .sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
}

/* ───────────────────────────────────────────────── Judge acceptance ── */

export type JudgeAccess =
  | { state: 'not-found' }
  | { state: 'invalid-token' }
  | { state: 'creator-blocked'; goal: Goal }
  | { state: 'pending-acceptance'; goal: Goal }
  | { state: 'declined'; goal: Goal }
  | { state: 'awaiting-decision'; goal: Goal }
  | { state: 'decided'; goal: Goal };

/** Resolve what the /verify (judge) panel may show for a token. */
export async function getJudgeAccess(goalId: string, token: string): Promise<JudgeAccess> {
  await delay(80);
  resolveExpired();
  const goal = getGoals().find((g) => g.id === goalId);
  if (!goal) return { state: 'not-found' };
  if (goal.judge.acceptToken !== token && goal.shareToken !== token) return { state: 'invalid-token' };
  // Device isolation: the creator can never act as their own judge.
  if (getDeviceId() === goal.creatorDeviceId) return { state: 'creator-blocked', goal };

  if (goal.judge.status === 'declined') return { state: 'declined', goal };
  if (goal.judge.decision) return { state: 'decided', goal };
  // A goal the judge cancelled (at the user's request) is closed.
  if (goal.status === 'cancelled') return { state: 'decided', goal };
  if (goal.judge.status !== 'accepted') return { state: 'pending-acceptance', goal };
  return { state: 'awaiting-decision', goal };
}

function authorizeJudge(goalId: string, token: string): { goals: Goal[]; goal: Goal } {
  const goals = getGoals();
  const goal = goals.find((g) => g.id === goalId);
  if (!goal) throw new Error('Goal not found.');
  if (goal.judge.acceptToken !== token && goal.shareToken !== token) throw new Error('Invalid judge link.');
  if (getDeviceId() === goal.creatorDeviceId) throw new Error('You cannot judge your own goal.');
  return { goals, goal };
}

/**
 * Judge accepts the role and sets their secret code. The acceptance + code are
 * stored as a standing credential for this goal-owner, so the same owner can
 * assign this judge again without re-asking. The code is required to verify any
 * of that owner's goals later.
 */
export async function acceptJudge(goalId: string, token: string, code: string): Promise<Goal> {
  await delay();
  const { goals, goal } = authorizeJudge(goalId, token);
  const trimmed = (code ?? '').trim();
  if (trimmed.length < JUDGE_CODE_MIN) {
    throw new Error(`Set a secret code of at least ${JUDGE_CODE_MIN} characters.`);
  }
  // Attribute the role to the judge's logged-in account (if any and not the creator).
  const sessionId = read<string | null>(KEYS.session, null);
  const judgeAccountUserId: string | undefined =
    sessionId && sessionId !== goal.userId ? sessionId : goal.judge.judgeAccountUserId;
  goal.judge = { ...goal.judge, status: 'accepted', acceptedAt: new Date().toISOString(), codeSet: true, judgeAccountUserId };
  upsertJudgeCredential(goal.userId, judgeKeyFor(goal.judge), trimmed, judgeAccountUserId ?? undefined);
  saveGoals(goals);
  logLegalAcceptance({ type: 'judge_role_ack', contact: goal.judge.judgeContact, goalId: goal.id });
  logAudit({ actorContact: goal.judge.judgeContact, actionType: 'judge_accepted', entityType: 'goal', entityId: goal.id });
  reevaluateGoals((g) => g.id === goal.id);
  return getGoals().find((g) => g.id === goal.id)!;
}

/** Verify a judge's secret code against the owner's standing credential. */
function verifyJudgeCode(goal: Goal, code: string): void {
  const cred = findJudgeCredential(goal.userId, judgeKeyFor(goal.judge));
  if (!cred) throw new Error('No secret code is on file. Accept the judge role first.');
  if (cred.codeHash !== hashCode((code ?? '').trim())) throw new Error('Incorrect secret code.');
}

export async function declineJudge(goalId: string, token: string): Promise<Goal> {
  await delay();
  const { goals, goal } = authorizeJudge(goalId, token);
  goal.judge = { ...goal.judge, status: 'declined', declinedAt: new Date().toISOString() };
  // A declined judge means the goal never becomes active.
  goal.status = 'cancelled';
  goal.cancelledAt = new Date().toISOString();
  saveGoals(goals);
  logAudit({ actorContact: goal.judge.judgeContact, actionType: 'judge_declined', entityType: 'goal', entityId: goal.id });
  return goal;
}

/**
 * Record the judge's decision. `completed` → completed. `not_completed` →
 * dispatch notifications to accepted recipients. `needs_proof` → judge_review.
 */
export async function judgeDecision(
  goalId: string,
  token: string,
  decision: JudgeDecision,
  comment: string | undefined,
  code: string,
): Promise<Goal> {
  await delay();
  const { goals, goal } = authorizeJudge(goalId, token);
  verifyJudgeCode(goal, code);
  // The judge may decide before the deadline ONLY if the creator asked for it.
  const pastDeadline = Date.now() > +new Date(goal.deadlineAt);
  if (goal.status === 'active' && !pastDeadline && !goal.earlyDecisionRequested) {
    throw new Error('You can decide after the deadline, or once the user asks you to decide early.');
  }
  applyJudgeDecision(goals, goal, decision, comment, { actorContact: goal.judge.judgeContact });
  return getGoals().find((g) => g.id === goal.id)!;
}

/**
 * The judge cancels a goal — used only when the creator asks them to (the
 * creator can no longer cancel an active goal themselves). No code needed:
 * cancelling never sends a message, so it's safe without the secret code.
 */
export async function judgeCancelGoal(goalId: string, token: string): Promise<Goal> {
  await delay();
  const { goals, goal } = authorizeJudge(goalId, token);
  if (goal.judge.status !== 'accepted') throw new Error('Accept the judge role first.');
  if (!goal.cancelRequested) throw new Error('The user has not asked you to cancel this goal.');
  if (!CANCELLABLE_STATUSES.includes(goal.status)) throw new Error('This goal cannot be cancelled now.');
  goal.status = 'cancelled';
  goal.cancelledAt = new Date().toISOString();
  saveGoals(goals);
  logAudit({ actorContact: goal.judge.judgeContact, actionType: 'judge_cancelled_goal', entityType: 'goal', entityId: goal.id });
  return getGoals().find((g) => g.id === goal.id)!;
}

/** Shared decision effects for both the link-based judge and a trainer-judge. */
function applyJudgeDecision(
  goals: Goal[],
  goal: Goal,
  decision: JudgeDecision,
  comment: string | undefined,
  actor: { actorId?: string; actorContact?: string },
) {
  if (goal.judge.status !== 'accepted') throw new Error('Accept the judge role first.');
  if (!['active', 'proof_pending', 'judge_review'].includes(goal.status)) {
    throw new Error('This goal is not ready for a decision yet.');
  }
  if (goal.judge.decision === 'completed' || goal.status === 'failed_notified') {
    throw new Error('This goal has already been decided.');
  }

  const at = new Date().toISOString();
  goal.judge = {
    ...goal.judge,
    decision,
    decisionAt: at,
    decisionComment: comment?.trim() || undefined,
    decisionEvidence: goal.evidence.slice(),
  };

  if (decision === 'needs_proof') {
    goal.status = 'judge_review';
    saveGoals(goals);
    logAudit({ ...actor, actionType: 'judge_needs_proof', entityType: 'goal', entityId: goal.id });
    return;
  }
  if (decision === 'completed') {
    goal.status = 'completed';
    goal.completedAt = at;
    saveGoals(goals);
    logAudit({ ...actor, actionType: 'goal_completed', entityType: 'goal', entityId: goal.id });
    return;
  }
  goal.status = 'failed_pending_notification';
  goal.failedAt = at;
  saveGoals(goals);
  logAudit({ ...actor, actionType: 'goal_not_completed', entityType: 'goal', entityId: goal.id });
  dispatchFailureNotifications(goal.id);
}

/* ─────────────────────────────────────────────── Judge ratings ── */

/** Round to at most two decimal places and clamp into 0–5. */
function normalizeRating(value: number): number {
  const clamped = Math.min(5, Math.max(0, value));
  return Math.round(clamped * 100) / 100;
}

/**
 * The goal owner rates the judge (0–5, up to two decimals). Only judges who have
 * an account accumulate a rating. One rating per goal (re-rating replaces it).
 */
export async function rateJudge(goalId: string, raterUserId: string, value: number): Promise<Goal> {
  await delay(80);
  const goals = getGoals();
  const goal = goals.find((g) => g.id === goalId);
  if (!goal) throw new Error('Goal not found.');
  if (goal.userId !== raterUserId) throw new Error('Only the goal owner can rate the judge.');
  const judgeAccountUserId = goal.judge.judgeAccountUserId;
  if (!judgeAccountUserId) throw new Error('This judge has no account, so they cannot be rated.');
  if (!goal.judge.decision) throw new Error('You can only rate the judge after they decide.');

  const v = normalizeRating(value);
  goal.judge = { ...goal.judge, judgeRating: v };
  saveGoals(goals);

  const ratings = read<JudgeRating[]>(KEYS.judgeRatings, []).filter((r) => r.goalId !== goalId);
  ratings.push({
    id: uid('jr'),
    judgeUserId: judgeAccountUserId,
    raterUserId,
    goalId,
    value: v,
    createdAt: new Date().toISOString(),
  });
  write(KEYS.judgeRatings, ratings);
  logAudit({ actorId: raterUserId, actionType: 'judge_rated', entityType: 'user', entityId: judgeAccountUserId, metadata: { goalId, value: v } });
  return goal;
}

/** Average judge rating (0–5, two decimals) and number of ratings for an account. */
export async function getJudgeRatingSummary(userId: string): Promise<{ avg: number; count: number }> {
  await delay(60);
  const ratings = read<JudgeRating[]>(KEYS.judgeRatings, []).filter((r) => r.judgeUserId === userId);
  if (ratings.length === 0) return { avg: 0, count: 0 };
  const avg = ratings.reduce((s, r) => s + r.value, 0) / ratings.length;
  return { avg: Math.round(avg * 100) / 100, count: ratings.length };
}

/* ── Trainer-authorized judge actions (from the coach panel, no share link) ── */

function authorizeJudgeByUser(goalId: string, userId: string): { goals: Goal[]; goal: Goal } {
  const goals = getGoals();
  const goal = goals.find((g) => g.id === goalId);
  if (!goal) throw new Error('Goal not found.');
  if (goal.userId === userId) throw new Error('You cannot judge your own goal.');
  if (goal.judge.judgeUserId !== userId) throw new Error('You are not the judge for this goal.');
  return { goals, goal };
}

export async function acceptJudgeByUser(goalId: string, userId: string): Promise<Goal> {
  await delay();
  const { goals, goal } = authorizeJudgeByUser(goalId, userId);
  goal.judge = { ...goal.judge, status: 'accepted', acceptedAt: new Date().toISOString() };
  saveGoals(goals);
  logLegalAcceptance({ type: 'judge_role_ack', userId, goalId: goal.id });
  logAudit({ actorId: userId, actionType: 'judge_accepted', entityType: 'goal', entityId: goal.id });
  reevaluateGoals((g) => g.id === goal.id);
  return getGoals().find((g) => g.id === goal.id)!;
}

export async function judgeDecisionByUser(
  goalId: string,
  userId: string,
  decision: JudgeDecision,
  comment?: string,
): Promise<Goal> {
  await delay();
  const { goals, goal } = authorizeJudgeByUser(goalId, userId);
  applyJudgeDecision(goals, goal, decision, comment, { actorId: userId });
  return getGoals().find((g) => g.id === goal.id)!;
}

/** Reschedule a planned step to another date. Does NOT change progress. */
export async function reschedulePlannedAction(goalId: string, actionId: string, newDateISO: string): Promise<Goal> {
  await delay(60);
  const goals = getGoals();
  const goal = goals.find((g) => g.id === goalId);
  if (!goal) throw new Error('Goal not found.');
  goal.plannedActions = goal.plannedActions.map((p) =>
    p.id === actionId
      ? { ...p, rescheduledFrom: p.plannedDate ?? p.rescheduledFrom, plannedDate: newDateISO, status: 'rescheduled', updatedAt: new Date().toISOString() }
      : p,
  );
  saveGoals(goals);
  logAudit({ actorId: goal.userId, actionType: 'step_rescheduled', entityType: 'goal', entityId: goal.id, metadata: { actionId, to: newDateISO } });
  return goal;
}

/** Delete a proof/confirmation before the judge decides. */
export async function deleteEvidence(goalId: string, evidenceId: string): Promise<Goal> {
  await delay(60);
  const goals = getGoals();
  const goal = goals.find((g) => g.id === goalId);
  if (!goal) throw new Error('Goal not found.');
  goal.evidence = goal.evidence.filter((e) => e.id !== evidenceId);
  // Free any planned action that was linked to this proof.
  goal.plannedActions = goal.plannedActions.map((p) =>
    p.evidenceId === evidenceId ? { ...p, status: 'planned', evidenceId: undefined, updatedAt: new Date().toISOString() } : p,
  );
  saveGoals(goals);
  logAudit({ actorId: goal.userId, actionType: 'evidence_deleted', entityType: 'goal', entityId: goal.id, metadata: { evidenceId } });
  return goal;
}

/* ─────────────────────────────────────────── Account type / trainer ── */

export async function setAccountType(userId: string, accountType: 'standard' | 'trainer'): Promise<User> {
  await delay(80);
  const user = getUsers().find((u) => u.id === userId);
  if (!user) throw new Error('User not found.');
  logAudit({ actorId: userId, actionType: 'account_type_changed', entityType: 'user', entityId: userId, metadata: { accountType } });
  return normalizeUser(persistUser({ ...user, accountType }));
}

function getTrainerClients(): TrainerClient[] {
  return read<TrainerClient[]>(KEYS.trainerClients, []);
}
function saveTrainerClients(list: TrainerClient[]) {
  write(KEYS.trainerClients, list);
}

/** Get (or create) the trainer's reusable, open invite link record. */
export async function getOrCreateTrainerInvite(trainerUserId: string): Promise<TrainerClient> {
  await delay(60);
  const trainer = getUsers().find((u) => u.id === trainerUserId);
  if (!trainer || trainer.accountType !== 'trainer') throw new Error('Only trainer accounts can invite clients.');
  const list = getTrainerClients();
  const open = list.find((t) => t.trainerUserId === trainerUserId && t.status === 'pending' && !t.clientUserId);
  if (open) return open;
  const record: TrainerClient = {
    id: uid('tc'),
    trainerUserId,
    status: 'pending',
    invitedBy: 'trainer',
    inviteToken: uuid(),
    createdAt: new Date().toISOString(),
  };
  list.push(record);
  saveTrainerClients(list);
  return record;
}

export async function getTrainerInvite(token: string): Promise<{ trainerName: string } | null> {
  await delay(60);
  const rec = getTrainerClients().find((t) => t.inviteToken === token);
  if (!rec) return null;
  const trainer = getUsers().find((u) => u.id === rec.trainerUserId);
  return { trainerName: trainer?.name ?? 'A trainer' };
}

/** Client accepts a trainer's invite → an accepted trainer↔client link is created. */
export async function acceptTrainerInvite(token: string, clientUserId: string): Promise<TrainerClient> {
  await delay();
  const list = getTrainerClients();
  const open = list.find((t) => t.inviteToken === token);
  if (!open) throw new Error('Invite not found.');
  if (open.trainerUserId === clientUserId) throw new Error('You cannot add yourself as your own client.');
  const client = getUsers().find((u) => u.id === clientUserId);
  const existing = list.find(
    (t) => t.trainerUserId === open.trainerUserId && t.clientUserId === clientUserId && t.status !== 'revoked',
  );
  if (existing) {
    existing.status = 'accepted';
    existing.acceptedAt = new Date().toISOString();
    existing.clientName = client?.name ?? existing.clientName;
    saveTrainerClients(list);
    return existing;
  }
  const record: TrainerClient = {
    id: uid('tc'),
    trainerUserId: open.trainerUserId,
    clientUserId,
    clientName: client?.name,
    status: 'accepted',
    invitedBy: 'trainer',
    inviteToken: uuid(),
    acceptedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  };
  list.push(record);
  saveTrainerClients(list);
  logAudit({ actorId: clientUserId, actionType: 'trainer_client_accepted', entityType: 'trainer_client', entityId: record.id, metadata: { trainerUserId: open.trainerUserId } });
  return record;
}

export async function revokeTrainerClient(id: string): Promise<void> {
  await delay(60);
  const list = getTrainerClients().map((t) =>
    t.id === id ? { ...t, status: 'revoked' as const, revokedAt: new Date().toISOString() } : t,
  );
  saveTrainerClients(list);
}

/** Accepted client links for a trainer. */
export async function listTrainerClients(trainerUserId: string): Promise<TrainerClient[]> {
  await delay(60);
  return getTrainerClients().filter((t) => t.trainerUserId === trainerUserId && t.status === 'accepted' && !!t.clientUserId);
}

/** Trainers a client has accepted — offered as judges when creating a goal. */
export async function listMyTrainers(clientUserId: string): Promise<{ id: string; name: string }[]> {
  await delay(60);
  const accepted = getTrainerClients().filter((t) => t.clientUserId === clientUserId && t.status === 'accepted');
  const users = getUsers();
  return accepted
    .map((t) => users.find((u) => u.id === t.trainerUserId))
    .filter((u): u is User => !!u && !u.deleted)
    .map((u) => ({ id: u.id, name: u.name }));
}

/**
 * The single, guarded place that sends failure messages. For each recipient it
 * verifies EVERY condition before sending, logs each send or suppression, and
 * never messages a recipient who has not accepted or who has revoked consent.
 */
export function dispatchFailureNotifications(goalId: string): void {
  const goals = getGoals();
  const goal = goals.find((g) => g.id === goalId);
  if (!goal) return;
  // Guard: only a not_completed decision on a pending-notification goal sends.
  if (goal.status !== 'failed_pending_notification') return;
  if (goal.judge.decision !== 'not_completed') return;

  const owner = getUsers().find((u) => u.id === goal.userId);
  const consents = getConsents();
  const notifications = getNotifications();
  const body = failureMessageForGoal(goal);
  const now = new Date().toISOString();

  goal.recipients = goal.recipients.map((r) => {
    const consent = consents.find((c) => c.id === r.consentId);
    let status: NotificationLog['status'] = 'sent';
    let reason: string | undefined;

    if (!consent) {
      status = 'suppressed';
      reason = 'consent_missing';
    } else if (consent.consentStatus === 'revoked') {
      status = 'suppressed';
      reason = 'consent_revoked';
    } else if (consent.consentStatus !== 'accepted') {
      status = 'suppressed';
      reason = 'not_accepted';
    } else if (!owner) {
      status = 'suppressed';
      reason = 'owner_missing';
    }

    notifications.push({
      id: uid('ntf'),
      goalId: goal.id,
      ownerUserId: goal.userId,
      recipientConsentId: r.consentId,
      channel: consent?.channel ?? 'internal',
      tone: goal.messageTone,
      status,
      reason,
      body,
      createdAt: now,
    });

    if (status === 'sent' && consent) {
      consent.lastNotifiedAt = now;
      return { ...r, notifiedAt: now, suppressed: false };
    }
    return { ...r, suppressed: true, suppressReason: reason };
  });

  goal.status = 'failed_notified';
  saveConsents(consents);
  saveNotifications(notifications);
  saveGoals(goals);
  logAudit({ actorId: goal.userId, actionType: 'failure_notifications_dispatched', entityType: 'goal', entityId: goal.id, metadata: { sent: goal.recipients.filter((r) => !r.suppressed).length } });
}

export async function listGoalNotifications(goalId: string): Promise<NotificationLog[]> {
  await delay(60);
  return getNotifications().filter((n) => n.goalId === goalId);
}

/* ─────────────────────────────────────────── Recipient consent flows ── */

export async function getConsentByToken(token: string): Promise<{ consent: RecipientConsent; ownerName: string } | null> {
  await delay(60);
  const consent = getConsents().find((c) => c.inviteToken === token);
  if (!consent) return null;
  const owner = getUsers().find((u) => u.id === consent.ownerUserId);
  return { consent, ownerName: owner?.name ?? 'A Comitra user' };
}

export async function acceptRecipientConsent(token: string): Promise<RecipientConsent> {
  await delay();
  const consents = getConsents();
  const consent = consents.find((c) => c.inviteToken === token);
  if (!consent) throw new Error('Invite not found.');
  if (consent.consentStatus !== 'revoked') {
    consent.consentStatus = 'accepted';
    consent.acceptedAt = new Date().toISOString();
    saveConsents(consents);
    logLegalAcceptance({ type: 'recipient_consent', contact: consent.recipientContact, meta: { consentId: consent.id, ownerUserId: consent.ownerUserId } });
    logAudit({ actorContact: consent.recipientContact, actionType: 'recipient_consent_accepted', entityType: 'recipient_consent', entityId: consent.id });
    // Any goals of this owner waiting on this recipient may now activate.
    reevaluateGoals((g) => g.userId === consent.ownerUserId);
  }
  return consent;
}

/**
 * Recipient opts out. Sets consent to revoked (keeping the historical record),
 * records the revocation date, and guarantees no further messages are sent.
 */
export async function revokeRecipientConsent(token: string): Promise<RecipientConsent> {
  await delay();
  const consents = getConsents();
  const consent = consents.find((c) => c.inviteToken === token);
  if (!consent) throw new Error('Invite not found.');
  consent.consentStatus = 'revoked';
  consent.revokedAt = new Date().toISOString();
  saveConsents(consents);
  logAudit({ actorContact: consent.recipientContact, actionType: 'recipient_consent_revoked', entityType: 'recipient_consent', entityId: consent.id });
  return consent;
}

/** Consents a given owner has (for the "Recipients" management view). */
export async function listOwnerConsents(ownerUserId: string): Promise<RecipientConsent[]> {
  await delay(60);
  return getConsents()
    .filter((c) => c.ownerUserId === ownerUserId)
    .sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
}

export async function reportAbuse(input: {
  reporterRole: 'recipient' | 'judge';
  reporterContact?: string;
  ownerUserId?: string;
  goalId?: string;
  consentId?: string;
  reason: string;
}): Promise<AbuseReport> {
  await delay();
  const report: AbuseReport = {
    id: uid('abuse'),
    ...input,
    reason: input.reason.trim().slice(0, 1000),
    createdAt: new Date().toISOString(),
  };
  const list = read<AbuseReport[]>(KEYS.abuseReports, []);
  list.unshift(report);
  write(KEYS.abuseReports, list);
  logAudit({ actorContact: input.reporterContact, actionType: 'abuse_reported', entityType: 'goal', entityId: input.goalId ?? input.consentId ?? '', metadata: { role: input.reporterRole } });
  return report;
}

/* ───────────────────────────────────────────────────────────── Social ── */

export type Relationship = 'friends' | 'following' | 'follows-you' | 'none';

export interface SocialProfile {
  id: string;
  name: string;
  avatar: string;
  bio: string;
  status: Relationship;
  followers: number;
  following: number;
  isPrivate: boolean;
}

export interface FollowListResult {
  hidden: boolean;
  profiles: SocialProfile[];
}

const FAKE_PROFILES: {
  id: string;
  name: string;
  avatar: string;
  bio: string;
  followsYou: boolean;
  youFollow: boolean;
  popularity: number;
  completed?: number;
  failed?: number;
}[] = [
  { id: 'fake_nova', name: 'Nova Quantum', avatar: 'preset-2', bio: 'Early riser. No zero days.', followsYou: true, youFollow: true, popularity: 11, completed: 12, failed: 2 },
  { id: 'fake_kai', name: 'Kai Vector', avatar: 'preset-3', bio: 'Building better habits.', followsYou: true, youFollow: true, popularity: 9, completed: 9, failed: 6 },
  { id: 'fake_mira', name: 'Mira Volt', avatar: 'preset-5', bio: 'One small step at a time.', followsYou: true, youFollow: true, popularity: 8, completed: 7, failed: 1 },
  { id: 'fake_zara', name: 'Zara Pulse', avatar: 'preset-4', bio: 'Reader & coffee snob.', followsYou: true, youFollow: false, popularity: 6, completed: 3, failed: 2 },
  { id: 'fake_lyra', name: 'Lyra Mono', avatar: 'preset-1', bio: 'Learning something new.', followsYou: true, youFollow: false, popularity: 5, completed: 4, failed: 0 },
  { id: 'fake_echo', name: 'Echo Raven', avatar: 'preset-6', bio: 'Consistency over intensity.', followsYou: false, youFollow: false, popularity: 3, completed: 5, failed: 5 },
  { id: 'fake_orin', name: 'Orin Flux', avatar: 'preset-2', bio: 'Shipping side projects.', followsYou: false, youFollow: false, popularity: 2, completed: 6, failed: 3 },
  { id: 'fake_iris', name: 'Iris Cordon', avatar: 'preset-4', bio: 'Finishing what I start.', followsYou: false, youFollow: false, popularity: 7, completed: 4, failed: 8 },
  { id: 'fake_dex', name: 'Dex Halloway', avatar: 'preset-6', bio: 'Deep work every morning.', followsYou: false, youFollow: false, popularity: 4, completed: 2, failed: 1 },
  { id: 'fake_juno', name: 'Juno Park', avatar: 'preset-3', bio: 'Daily progress.', followsYou: false, youFollow: false, popularity: 10, completed: 15, failed: 10 },
];

const POPULARITY = new Map(FAKE_PROFILES.map((p) => [p.id, p.popularity]));

function blankFakeUser(p: (typeof FAKE_PROFILES)[number]): User {
  return {
    id: p.id,
    name: p.name,
    email: `${p.id}@demo.comitra`,
    password: '',
    accountType: 'standard',
    subscription: { status: 'active', priceUsd: SUBSCRIPTION_PRICE_MONTHLY, provider: 'placeholder', startedAt: new Date().toISOString() },
    plan: 'premium',
    isPremium: true,
    theme: 'default',
    createdAt: new Date().toISOString(),
    bio: p.bio,
    avatar: p.avatar,
    following: [],
    isPrivate: false,
  };
}

function fakeTerminalGoal(userId: string, name: string, status: GoalStatus, hoursAgo: number, title: string): Goal {
  const at = new Date(Date.now() - hoursAgo * 3_600_000).toISOString();
  const decision: JudgeDecision | undefined =
    status === 'completed' ? 'completed' : status === 'failed_notified' ? 'not_completed' : undefined;
  return {
    id: uuid(),
    userId,
    creatorName: name,
    creatorDeviceId: 'seed-device',
    title,
    description: '',
    requiredActionsCount: 3,
    plannedActions: [],
    deadlineAt: at,
    status,
    messageTone: 'neutral',
    includeGoalTitleInFailureMessage: false,
    includeGoalDescriptionInFailureMessage: false,
    ackNotifyConsent: true,
    evidence: [],
    judge: { name: 'Seed', channel: 'internal', status: decision ? 'accepted' : 'pending', acceptToken: uuid(), decision, decisionAt: decision ? at : undefined },
    recipients: [],
    shareToken: uuid(),
    createdAt: at,
    completedAt: status === 'completed' ? at : undefined,
    failedAt: status === 'failed_notified' ? at : undefined,
  };
}

const TITLES = ['Study 5x this week', 'Finish the report in 14 days', 'Read 12 chapters in 30 days', 'Write 4x weekly', 'Journal every morning', 'Inbox zero daily', 'Practice 3 times', 'Ship the side project'];

const isListable = (u: User) => !u.isGuest && !u.deleted;

function ensureDemoGraph() {
  const MARKER = 'demo:graph:seeded:v2';
  if (read<boolean>(MARKER, false)) return;
  const users = getUsers();
  const goals = getGoals();
  for (const p of FAKE_PROFILES) {
    if (!users.some((u) => u.id === p.id)) users.push(blankFakeUser(p));
    // Seed some finished goals for profile history + leaderboards.
    const existing = goals.filter((g) => g.userId === p.id).length;
    if (existing === 0) {
      for (let i = 0; i < (p.completed ?? 0); i++) {
        goals.push(fakeTerminalGoal(p.id, p.name, 'completed', 24 * (i + 2), TITLES[i % TITLES.length]));
      }
      for (let i = 0; i < (p.failed ?? 0); i++) {
        goals.push(fakeTerminalGoal(p.id, p.name, 'failed_notified', 24 * (i + 2) + 6, TITLES[(i + 3) % TITLES.length]));
      }
    }
  }
  const ids = FAKE_PROFILES.map((p) => p.id);
  const hubs = ids.slice(0, 2);
  for (let i = 0; i < ids.length; i++) {
    const follower = users.find((u) => u.id === ids[i]);
    if (!follower) continue;
    const targets = new Set<string>([ids[(i + 1) % ids.length], ids[(i + 2) % ids.length], ...hubs]);
    targets.delete(ids[i]);
    for (const t of targets) if (!follower.following.includes(t)) follower.following = [...follower.following, t];
  }
  saveUsers(users);
  saveGoals(goals);
  write(MARKER, true);
}

function seedSocial(currentUserId: string) {
  ensureDemoGraph();
  const marker = `social:seeded:v2:${currentUserId}`;
  if (read<boolean>(marker, false)) return;
  const users = getUsers();
  const me = users.find((u) => u.id === currentUserId);
  if (!me || me.isGuest) return;
  for (const p of FAKE_PROFILES) {
    const fake = users.find((u) => u.id === p.id);
    if (!fake) continue;
    if (p.followsYou && !fake.following.includes(currentUserId)) fake.following = [...fake.following, currentUserId];
    if (p.youFollow && !me.following.includes(p.id)) me.following = [...me.following, p.id];
  }
  saveUsers(users);
  write(marker, true);
}

function relationship(me: User, other: User): Relationship {
  const iFollow = me.following.includes(other.id);
  const followsMe = other.following.includes(me.id);
  if (iFollow && followsMe) return 'friends';
  if (iFollow) return 'following';
  if (followsMe) return 'follows-you';
  return 'none';
}

function buildFollowerCounts(users: User[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const u of users) for (const id of u.following) m.set(id, (m.get(id) ?? 0) + 1);
  return m;
}

function toSocialProfile(u: User, me: User, followerCount: Map<string, number>): SocialProfile {
  return {
    id: u.id,
    name: u.name,
    avatar: u.avatar,
    bio: u.bio ?? '',
    status: relationship(me, u),
    followers: (followerCount.get(u.id) ?? 0) + (POPULARITY.get(u.id) ?? 0),
    following: u.following.length,
    isPrivate: u.isPrivate ?? false,
  };
}

export async function listProfiles(currentUserId: string): Promise<SocialProfile[]> {
  await delay(80);
  seedSocial(currentUserId);
  const users = getUsers();
  const me = users.find((u) => u.id === currentUserId);
  if (!me) return [];
  const fc = buildFollowerCounts(users);
  return users.filter((u) => u.id !== currentUserId && isListable(u)).map((u) => toSocialProfile(u, me, fc));
}

export async function getProfile(viewerId: string, targetId: string): Promise<SocialProfile | null> {
  await delay(80);
  seedSocial(viewerId);
  const users = getUsers();
  const me = users.find((u) => u.id === viewerId);
  const target = users.find((u) => u.id === targetId);
  if (!me || !target || !isListable(target)) return null;
  return toSocialProfile(target, me, buildFollowerCounts(users));
}

export async function getFollowStats(userId: string): Promise<{ followers: number; following: number }> {
  await delay(60);
  seedSocial(userId);
  const users = getUsers();
  const me = users.find((u) => u.id === userId);
  if (!me) return { followers: 0, following: 0 };
  const fc = buildFollowerCounts(users);
  return { followers: (fc.get(userId) ?? 0) + (POPULARITY.get(userId) ?? 0), following: me.following.length };
}

export async function listFollowers(viewerId: string, targetId: string): Promise<FollowListResult> {
  await delay(80);
  seedSocial(viewerId);
  const users = getUsers();
  const viewer = users.find((u) => u.id === viewerId);
  const target = users.find((u) => u.id === targetId);
  if (!viewer || !target) return { hidden: false, profiles: [] };
  if (target.id !== viewer.id && (target.isPrivate ?? false)) return { hidden: true, profiles: [] };
  const fc = buildFollowerCounts(users);
  const profiles = users
    .filter((u) => u.id !== viewerId && u.following.includes(targetId) && isListable(u))
    .map((u) => toSocialProfile(u, viewer, fc));
  return { hidden: false, profiles };
}

export async function listFollowing(viewerId: string, targetId: string): Promise<FollowListResult> {
  await delay(80);
  seedSocial(viewerId);
  const users = getUsers();
  const viewer = users.find((u) => u.id === viewerId);
  const target = users.find((u) => u.id === targetId);
  if (!viewer || !target) return { hidden: false, profiles: [] };
  if (target.id !== viewer.id && (target.isPrivate ?? false)) return { hidden: true, profiles: [] };
  const fc = buildFollowerCounts(users);
  const profiles = target.following
    .map((id) => users.find((u) => u.id === id))
    .filter((u): u is User => !!u && u.id !== viewerId && isListable(u))
    .map((u) => toSocialProfile(u, viewer, fc));
  return { hidden: false, profiles };
}

export async function listFriends(currentUserId: string): Promise<SocialProfile[]> {
  const all = await listProfiles(currentUserId);
  return all.filter((p) => p.status === 'friends');
}

/** Per-friend performance stats for the Friends leaderboard. */
export interface FriendStat {
  id: string;
  name: string;
  avatar: string;
  isMe: boolean;
  /** Completed goals in the last 30 days. */
  completed30: number;
  /** Completed goals in the last 90 days (≈ 3 months). */
  completed90: number;
  completedTotal: number;
  /** completed / (completed + not-completed), as a percent — null if none resolved. */
  successRate: number | null;
}

/**
 * Stats for the current user + their friends (mutual follows), for the Friends
 * tab rankings: success rate and completed goals in the last 30 / 90 days.
 */
export async function getFriendsStats(currentUserId: string): Promise<FriendStat[]> {
  await delay(100);
  seedSocial(currentUserId);
  resolveExpired();
  const users = getUsers();
  const me = users.find((u) => u.id === currentUserId);
  if (!me) return [];
  // Friends = people I follow AND who follow me back.
  const people = users.filter(
    (u) => isListable(u) && (u.id === currentUserId || (me.following.includes(u.id) && u.following.includes(currentUserId))),
  );
  const goals = getGoals();
  const now = Date.now();
  const within = (iso: string | undefined, days: number) =>
    !!iso && now - +new Date(iso) <= days * 86_400_000;

  return people
    .map((u): FriendStat => {
      const mine = goals.filter((g) => g.userId === u.id);
      const completed = mine.filter((g) => g.status === 'completed');
      const failed = mine.filter((g) => g.status === 'failed_notified');
      const resolved = completed.length + failed.length;
      return {
        id: u.id,
        name: u.name,
        avatar: u.avatar,
        isMe: u.id === currentUserId,
        completed30: completed.filter((g) => within(g.completedAt ?? g.createdAt, 30)).length,
        completed90: completed.filter((g) => within(g.completedAt ?? g.createdAt, 90)).length,
        completedTotal: completed.length,
        successRate: resolved > 0 ? Math.round((completed.length / resolved) * 100) : null,
      };
    })
    .sort((a, b) => b.completed30 - a.completed30 || (b.successRate ?? -1) - (a.successRate ?? -1));
}

export async function toggleFollow(currentUserId: string, targetId: string): Promise<User> {
  await delay(80);
  const me = getUsers().find((u) => u.id === currentUserId);
  if (!me) throw new Error('User not found.');
  if (me.isGuest) throw new Error('Create an account to follow people.');
  const following = me.following.includes(targetId)
    ? me.following.filter((id) => id !== targetId)
    : [...me.following, targetId];
  return normalizeUser(persistUser({ ...me, following }));
}

/** A simple streak: consecutive completed goals from the most recent. */
export async function getStreak(userId: string): Promise<{ goals: number }> {
  await delay(60);
  resolveExpired();
  const terminal: GoalStatus[] = ['completed', 'failed_notified', 'expired_without_judge_decision'];
  const mine = getGoals()
    .filter((g) => g.userId === userId && terminal.includes(g.status))
    .sort((a, b) => +new Date(b.completedAt ?? b.failedAt ?? b.createdAt) - +new Date(a.completedAt ?? a.failedAt ?? a.createdAt));

  // Leading run of completed goals from most recent.
  let goals = 0;
  for (const g of mine) {
    if (g.status === 'completed') goals++;
    else break;
  }
  return { goals };
}

/** Progress-journal entries: every proof the user added, newest first. */
export interface JournalEntry {
  goalId: string;
  goalTitle: string;
  evidence: GoalEvidence;
  judgeStatus: string;
}

export async function listJournal(userId: string): Promise<JournalEntry[]> {
  await delay(80);
  const entries: JournalEntry[] = [];
  for (const g of getGoals().filter((g) => g.userId === userId)) {
    for (const ev of g.evidence) {
      entries.push({
        goalId: g.id,
        goalTitle: g.title,
        evidence: ev,
        judgeStatus: g.judge?.decision ?? g.judge?.status ?? 'pending',
      });
    }
  }
  return entries.sort(
    (a, b) => +new Date(b.evidence.actionDate ?? b.evidence.addedAt) - +new Date(a.evidence.actionDate ?? a.evidence.addedAt),
  );
}

/** A user's finished (terminal) goals, newest first, for their public profile. */
export async function listCompletedGoals(userId: string): Promise<Goal[]> {
  await delay(80);
  resolveExpired();
  const terminal: GoalStatus[] = ['completed', 'failed_notified', 'cancelled', 'expired_without_judge_decision'];
  return getGoals()
    .filter((g) => g.userId === userId && terminal.includes(g.status))
    .sort((a, b) => +new Date(b.failedAt ?? b.completedAt ?? b.createdAt) - +new Date(a.failedAt ?? a.completedAt ?? a.createdAt));
}

/* ───────────────────────────────────── Leaderboards (no money) ── */

export type LeaderboardCategory = 'completions' | 'consistency';

export interface LeaderboardEntry {
  id: string;
  name: string;
  avatar: string;
  value: number; // count (completions) or percent (consistency)
  isMe: boolean;
}

export type Leaderboards = Record<LeaderboardCategory, LeaderboardEntry[]>;

export async function getLeaderboards(currentUserId: string): Promise<Leaderboards> {
  await delay(120);
  seedSocial(currentUserId);
  resolveExpired();
  const goals = getGoals();
  const eligible = getUsers().filter((u) => !u.deleted && !u.isGuest);
  const stats = eligible.map((u) => {
    const mine = goals.filter((g) => g.userId === u.id);
    const completed = mine.filter((g) => g.status === 'completed').length;
    const failed = mine.filter((g) => g.status === 'failed_notified').length;
    const resolved = completed + failed;
    return {
      id: u.id,
      name: u.name,
      avatar: u.avatar,
      isMe: u.id === currentUserId,
      completed,
      consistency: resolved > 0 ? Math.round((completed / resolved) * 100) : null,
    };
  });
  const completions = stats
    .filter((s) => s.completed > 0)
    .sort((a, b) => b.completed - a.completed)
    .slice(0, 100)
    .map((s) => ({ id: s.id, name: s.name, avatar: s.avatar, value: s.completed, isMe: s.isMe }));
  const consistency = stats
    .filter((s) => s.consistency != null)
    .sort((a, b) => b.consistency! - a.consistency! || b.completed - a.completed)
    .slice(0, 100)
    .map((s) => ({ id: s.id, name: s.name, avatar: s.avatar, value: s.consistency!, isMe: s.isMe }));
  return { completions, consistency };
}

/* ─────────────────────────────────────────────────────────── Leagues ── */

export async function listLeagues(ownerId: string): Promise<League[]> {
  await delay(80);
  return read<League[]>(KEYS.leagues, []).filter((l) => l.ownerId === ownerId);
}

export async function createLeague(
  ownerId: string,
  name: string,
  teamAName: string,
  teamAMembers: string[],
  teamBName: string,
  teamBMembers: string[],
): Promise<League> {
  await delay();
  const leagues = read<League[]>(KEYS.leagues, []);
  const league: League = {
    id: uid('lg'),
    ownerId,
    name: name.trim() || 'New League',
    createdAt: new Date().toISOString(),
    teamA: { id: uid('tm'), name: teamAName.trim() || 'Team A', members: teamAMembers.filter(Boolean).map((n) => ({ name: n, points: 0 })) },
    teamB: { id: uid('tm'), name: teamBName.trim() || 'Team B', members: teamBMembers.filter(Boolean).map((n) => ({ name: n, points: 0 })) },
  };
  leagues.push(league);
  write(KEYS.leagues, leagues);
  return league;
}

export async function addLeaguePoint(leagueId: string, team: 'A' | 'B', memberName: string): Promise<League> {
  await delay(60);
  const leagues = read<League[]>(KEYS.leagues, []);
  const league = leagues.find((l) => l.id === leagueId);
  if (!league) throw new Error('League not found.');
  const target = team === 'A' ? league.teamA : league.teamB;
  target.members = target.members.map((m) => (m.name === memberName ? { ...m, points: m.points + 1 } : m));
  write(KEYS.leagues, leagues);
  return league;
}

export async function deleteLeague(id: string): Promise<void> {
  await delay(60);
  write(KEYS.leagues, read<League[]>(KEYS.leagues, []).filter((l) => l.id !== id));
}

/* ────────────────────────────────────────────────── Feature requests ── */

function getFeatures(): FeatureRequest[] {
  return read<FeatureRequest[]>(KEYS.features, []);
}
function saveFeatures(features: FeatureRequest[]) {
  write(KEYS.features, features);
}
function toFeatureView(f: FeatureRequest, userId: string): FeatureRequestView {
  const dirs = Object.values(f.votes);
  const upCount = dirs.filter((v) => v === 1).length;
  const downCount = dirs.filter((v) => v === -1).length;
  return { ...f, upCount, downCount, score: upCount - downCount, myVote: f.votes[userId] ?? 0 };
}

const FEATURE_SEED: { title: string; description: string; author: string; up: number; down: number }[] = [
  { title: 'Streaks & badges', description: 'Reward consecutive completed goals with a visible streak counter.', author: 'Mira Volt', up: 12, down: 3 },
  { title: 'Calendar reminders', description: 'Optional reminders before a goal deadline so you never forget a step.', author: 'Nova Quantum', up: 18, down: 1 },
  { title: 'Dark-only OLED theme', description: 'A pure-black theme to save battery on AMOLED phones.', author: 'Echo Raven', up: 7, down: 0 },
];

function seedFeatures() {
  if (read<boolean>(KEYS.featuresSeeded, false)) return;
  const seeded: FeatureRequest[] = FEATURE_SEED.map((s, i) => {
    const votes: Record<string, 1 | -1> = {};
    for (let u = 0; u < s.up; u++) votes[`seed_up_${i}_${u}`] = 1;
    for (let d = 0; d < s.down; d++) votes[`seed_down_${i}_${d}`] = -1;
    return {
      id: uid('feat'),
      title: s.title,
      description: s.description,
      authorId: `seed_author_${i}`,
      authorName: s.author,
      createdAt: new Date(Date.now() - (i + 1) * 3_600_000).toISOString(),
      votes,
    };
  });
  saveFeatures([...getFeatures(), ...seeded]);
  write(KEYS.featuresSeeded, true);
}

export async function listFeatureRequests(userId: string): Promise<FeatureRequestView[]> {
  await delay(80);
  seedFeatures();
  return getFeatures()
    .map((f) => toFeatureView(f, userId))
    .sort((a, b) => b.score - a.score || +new Date(b.createdAt) - +new Date(a.createdAt));
}

export async function createFeatureRequest(userId: string, authorName: string, title: string, description: string): Promise<FeatureRequestView> {
  await delay();
  const cleanTitle = title.trim();
  if (cleanTitle.length < 3) throw new Error('Give your idea a title (at least 3 characters).');
  const feature: FeatureRequest = {
    id: uid('feat'),
    title: cleanTitle.slice(0, 80),
    description: description.trim().slice(0, 280),
    authorId: userId,
    authorName: authorName.trim() || 'Anonymous',
    createdAt: new Date().toISOString(),
    votes: { [userId]: 1 },
  };
  saveFeatures([...getFeatures(), feature]);
  return toFeatureView(feature, userId);
}

export async function voteFeatureRequest(userId: string, featureId: string, dir: 1 | -1): Promise<FeatureRequestView> {
  await delay(60);
  const features = getFeatures();
  const feature = features.find((f) => f.id === featureId);
  if (!feature) throw new Error('Feature request not found.');
  if (feature.votes[userId] === dir) delete feature.votes[userId];
  else feature.votes[userId] = dir;
  saveFeatures(features);
  return toFeatureView(feature, userId);
}

/* ─────────────────────────────────────────────────── Tester program ── */

export async function applyAsTester(input: { email: string; reason: string; name?: string; userId?: string }): Promise<TesterApplication> {
  await delay();
  const email = input.email.trim().toLowerCase();
  const reason = input.reason.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Enter a valid email address.');
  if (reason.length < 10) throw new Error('Tell us a little more (at least 10 characters).');
  const all = read<TesterApplication[]>(KEYS.testers, []);
  const existing = all.find((t) => t.email === email);
  const record: TesterApplication = {
    id: existing?.id ?? uid('tester'),
    email,
    reason: reason.slice(0, 600),
    name: input.name?.trim() || existing?.name,
    userId: input.userId ?? existing?.userId,
    createdAt: new Date().toISOString(),
  };
  write(KEYS.testers, existing ? all.map((t) => (t.email === email ? record : t)) : [record, ...all]);
  return record;
}

export async function listTesterApplications(): Promise<TesterApplication[]> {
  await delay(80);
  return read<TesterApplication[]>(KEYS.testers, []).sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
}
