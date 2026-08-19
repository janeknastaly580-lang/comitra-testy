/**
 * The app's data layer.
 *
 * This is the SOCIAL-COMMITMENT / SUBSCRIPTION model. There is no money,
 * deposit, stake, pot, token, wallet or reward anywhere. The only consequence
 * of a missed goal is an optional message to pre-approved recipients.
 *
 * WHERE THE DATA IS. Accounts and everything in them live on the server (see
 * `src/lib/account.ts` and supabase/comitra_accounts.sql). LocalStorage is the
 * cache this module reads and writes synchronously — that is why every function
 * below still works on plain arrays — and `src/lib/cloud.ts` keeps that cache
 * and the server in step. Signing in on another device pulls the same account
 * document, so the goals, judges and settings are simply there.
 *
 * WITHOUT A BACKEND (no VITE_API_BASE, or inside vitest) every path below falls
 * back to what it used to do: a device-local account that works, but only here.
 * The fallback exists so the app is never bricked by a missing deployment, not
 * because it is a supported way to run it.
 */
import {
  remoteApplyPasswordReset,
  remoteDeleteAccount,
  remoteEmailAvailable,
  remoteLogin,
  remoteLogout,
  remoteRegister,
  remoteRename,
  remoteSession,
  remoteSocialLogin,
  signedInRemotely,
  type AuthResult,
} from './account';
import { backendEnabled } from './backend';
import * as cloud from './cloud';
import { cancelAppBlock, commitmentBlockId, penaltyBlockId, scheduleAppBlock } from './appBlock';
import { MAX_INVITES_PER_DAY, MAX_RECIPIENTS_PER_GOAL, SUBSCRIPTION_PRICE_MONTHLY, TRIAL_MS } from './constants';
import { goalNumberOf } from './goal';
import { failureMessageForGoal, recipientInviteMessage } from './messages';
import { getDeviceId, KEYS, read, uid, uuid, write } from './storage';
import { EVERYDAY, dayKey, fromDayKey, isDueOn } from './renewing';
import {
  remoteGetGoal,
  remoteJudgeAct,
  remoteListJudgingGoals,
  remotePutGoal,
  supabaseEnabled,
  SyncError,
  type JudgeAction,
} from './supabase';
import { chatEnabled, sendMessage as sendChatMessage, type ChatRequest } from './chat';
import {
  fetchGraph,
  fetchPeople,
  publishProfile,
  searchPeople,
  setFollow,
  socialSyncEnabled,
  type DirectoryPerson,
} from './social';
import { isNewerThan, mergeSharedGoal, sharedFingerprint, toSharedGoal, type SharedGoal } from './goalShare';
import {
  emailVerificationMode as emailOtpMode,
  requestPasswordReset,
  sendEmailOtp,
  verifyEmailOtp,
  type EmailVerifyMode,
  type OtpPurpose,
} from './email';
import { sendPush, type PushMessage, type PushOutcome } from './push';
import type {
  AbuseReport,
  AppBlockPenalty,
  AuditLog,
  FeatureRequest,
  FeatureRequestView,
  Goal,
  GoalJudge,
  GoalReflection,
  GoalStatus,
  JudgeDecision,
  JudgeRating,
  League,
  LegalAcceptance,
  MessageTone,
  NotificationLog,
  OutboxMessage,
  PlanId,
  PlannedAction,
  ProfileVisibility,
  RecipientConsent,
  RenewingEntry,
  RenewingEntryStatus,
  RenewingGoal,
  Subscription,
  TesterApplication,
  Weekday,
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

/**
 * Persist goals, and publish the ones a judge has to be able to open.
 *
 * A goal is created on its owner's phone; their judge opens the link on their
 * own. Nothing but the shared store can bridge that, so every save stamps the
 * goals whose shared part actually changed and pushes them. The push is
 * best-effort — a dead network must never break setting a goal — so anything
 * the judge needs to see NOW should `await flushGoalSync()` afterwards.
 */
function saveGoals(goals: Goal[]) {
  const before = new Map(getGoals().map((g) => [g.id, sharedFingerprint(g)]));
  const changed: Goal[] = [];
  for (const goal of goals) {
    if (before.get(goal.id) === sharedFingerprint(goal)) continue;
    goal.updatedAt = new Date().toISOString();
    changed.push(goal);
  }
  write(KEYS.goals, goals);
  for (const goal of changed) pushGoal(goal);
}

/* ────────────────────────────────────────────── shared goal store (sync) ── */

/** In-flight pushes, so a caller can wait for them (see `flushGoalSync`). */
const goalPushes = new Set<Promise<void>>();

/**
 * Publish one goal's shared projection. Solo goals are never pushed: nobody but
 * their owner can act on them, so there is nothing to share and no reason for a
 * copy to exist off the device.
 */
function pushGoal(goal: Goal): void {
  // Only the owner may publish, and the server enforces that against the stored
  // row — so a judge's device must not even try: it would be refused, and the
  // refusal would be logged as if something had gone wrong.
  if (!supabaseEnabled() || goal.noJudge) return;
  if (read<string | null>(KEYS.session, null) !== goal.userId) return;
  const task = remotePutGoal({
    id: goal.id,
    judgeUserId: goal.judge.judgeUserId,
    data: toSharedGoal(goal),
  })
    .catch((err) => {
      console.error('[sync] could not publish goal', goal.id, err);
    })
    .finally(() => {
      goalPushes.delete(task);
    });
  goalPushes.add(task);
}

/** Wait for every in-flight goal push to settle (never throws). */
export async function flushGoalSync(): Promise<void> {
  await Promise.allSettled([...goalPushes]);
}

/**
 * Fold a shared copy from the store into local storage. Returns the merged goal,
 * or the local one when the incoming copy is older.
 *
 * The owner keeps their title and details: `mergeSharedGoal` only ever takes the
 * allow-listed fields, so pulling the judge's decision can't blank the content
 * that was never uploaded in the first place.
 */
function absorbSharedGoal(shared: SharedGoal): Goal | null {
  if (!shared?.id) return null;
  const goals = getGoals();
  const local = goals.find((g) => g.id === shared.id) ?? null;
  if (!isNewerThan(shared, local)) return local;
  const merged = mergeSharedGoal(local, shared);
  const next = local ? goals.map((g) => (g.id === merged.id ? merged : g)) : [merged, ...goals];
  // Straight to storage: saveGoals would see a change and push it back, and a
  // pull is not a change.
  write(KEYS.goals, next);
  applyLocalConsequences(merged);
  return getGoals().find((g) => g.id === merged.id) ?? merged;
}

/**
 * Do, on THIS phone, what a verdict made on another one means here.
 *
 * A judge decides on their own device, so everything a decision costs has to
 * happen when the owner's device picks it up: the app block runs on the owner's
 * phone, and the recipients' consents exist nowhere else. Both are guarded on
 * being the owner — a judge absorbing the same row must not block their own
 * Instagram or try to message people they have never heard of.
 *
 * Idempotent by construction: every branch is a no-op the second time.
 */
function applyLocalConsequences(goal: Goal): void {
  if (read<string | null>(KEYS.session, null) !== goal.userId) return;

  if (goal.status === 'failed_pending_notification') dispatchFailureNotifications(goal.id);

  // The penalty block. `appBlockUntil` is set by whoever recorded the verdict —
  // possibly the server — but only the owner's phone can actually enforce it.
  if (goal.appBlock && goal.appBlockUntil) {
    const until = +new Date(goal.appBlockUntil);
    if (Number.isFinite(until) && until > Date.now()) {
      void scheduleAppBlock(penaltyBlockId(goal.id), goal.appBlock.packageName, goal.appBlock.appLabel, until);
    }
  }
  if (goal.status === 'completed' || goal.status === 'cancelled') {
    cancelAppBlock(penaltyBlockId(goal.id));
  }
  // A goal that ended releases the app its owner locked away for the duration.
  if (TERMINAL_STATUSES.includes(goal.status) && goal.commitmentBlock && !goal.commitmentBlock.liftedAt) {
    const goals = getGoals();
    const local = goals.find((g) => g.id === goal.id);
    if (local?.commitmentBlock && !local.commitmentBlock.liftedAt) {
      local.commitmentBlock = { ...local.commitmentBlock, liftedAt: new Date().toISOString() };
      write(KEYS.goals, goals);
      cancelAppBlock(commitmentBlockId(goal.id));
    }
  }
}

/**
 * Pull one goal from the shared store. The server answers only for the account
 * that owns it or the one judging it, so there is nothing to present but being
 * signed in. Best-effort by default; `strict` lets a caller tell "no such goal"
 * apart from "the server never answered", which are very different things.
 */
async function pullGoal(id: string, strict = false): Promise<Goal | null> {
  if (!supabaseEnabled() || !id) return null;
  try {
    const row = await remoteGetGoal(id);
    if (!row) return null;
    return absorbSharedGoal(row.data as SharedGoal);
  } catch (err) {
    if (strict) throw err;
    console.error('[sync] could not fetch goal', id, err);
    return null;
  }
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
 * Queue a message the system intends to deliver.
 *
 * The outbox is the RECORD of intent, shown on the goal screen so the owner can
 * see exactly what Comitra says on their behalf. Delivery itself is separate:
 * a judge message is a link the owner sends by hand (Comitra never contacts a
 * judge on its own), and a recipient message goes to their account through
 * `src/lib/push.ts`. Recipients must have consented before any message.
 */
function queueOutbox(
  msg: Omit<OutboxMessage, 'id' | 'createdAt' | 'status'> & { status?: OutboxMessage['status'] },
): OutboxMessage {
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

/** Messages queued for a goal (newest first), used by the goal detail view. */
export async function listOutbox(goalId: string): Promise<OutboxMessage[]> {
  await delay(50);
  return getOutbox().filter((m) => m.goalId === goalId);
}

/*
 * There is deliberately no "notify the judge" helper here.
 *
 * Asking the judge for anything — a decision, a change, a cancellation — is the
 * owner's own act: the goal screen gives them two links to send. Comitra sends
 * the judge nothing by itself, so a judge is never messaged about a goal its
 * owner didn't choose to hand them. See `applyJudgeLinkRequest`.
 */

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
 * True when the user may create/activate new goals, an active subscription OR a
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
  // Accounts made before the three-way setting existed: derive it from the old
  // boolean, then keep the boolean as a mirror so follower-list hiding still works.
  if (next.profileVisibility === undefined) {
    next.profileVisibility = next.isPrivate ? 'private' : 'public';
    changed = true;
  }
  const derivedPrivate = next.profileVisibility === 'private';
  if (next.isPrivate !== derivedPrivate) { next.isPrivate = derivedPrivate; changed = true; }

  return changed ? persistUser(next) : next;
}

function persistUser(user: User): User {
  const users = getUsers().map((u) => (u.id === user.id ? user : u));
  saveUsers(users);
  return user;
}

/** Placeholder subscribe: swap for Stripe/RevenueCat/App Store/Play later. */
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
    profileVisibility: 'public',
    isPrivate: false,
    ...over,
  };
}

/**
 * Whether an address can still be registered.
 *
 * Exists to be checked BEFORE a verification code is sent. `register` refuses a
 * duplicate too, but it only runs once the code has been typed back — so
 * without this the person fills in the form, waits for an email, types six
 * digits, and only THEN learns the address was taken. The send is wasted as
 * well, which matters while SES is capped at 200 messages a day.
 *
 * A deleted account does not hold its address: deleting has to free the email,
 * or someone who deletes and changes their mind is locked out of their own
 * address for good.
 */
export async function emailAvailable(email: string): Promise<boolean> {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return false;
  if (backendEnabled()) return remoteEmailAvailable(normalized);
  return !getUsers().some((u) => u.email === normalized && !u.deleted);
}

/* ─────────────────────────────────────── Adopting a server account ── */

/**
 * Work this device did before it was signed in, so signing in does not throw it
 * away.
 *
 * The obvious case is a guest who set a goal to try the app and then created an
 * account. The other one matters just as much: someone who used Comitra while
 * accounts were device-local, and is now logging in for the first time. Both are
 * "there are goals here that belong to the person now signing in".
 */
interface Carry {
  goals: Goal[];
  consents: RecipientConsent[];
}

function captureCarry(): Carry | null {
  // Already syncing means these rows came FROM the account and are not orphans.
  if (signedInRemotely()) return null;
  const id = read<string | null>(KEYS.session, null);
  if (!id) return null;
  const goals = getGoals().filter((g) => g.userId === id);
  const consents = getConsents().filter((c) => c.ownerUserId === id);
  return goals.length || consents.length ? { goals, consents } : null;
}

/**
 * Re-home carried work onto the account. Matching ids are left alone, so doing
 * this twice cannot duplicate anything.
 */
function absorbCarry(carry: Carry, owner: User): void {
  const goals = getGoals();
  const seen = new Set(goals.map((g) => g.id));
  for (const goal of carry.goals) {
    if (seen.has(goal.id)) continue;
    goals.unshift({
      ...goal,
      userId: owner.id,
      creatorName: owner.name,
      creatorAvatar: owner.avatar,
      // Renumbered into the account's own sequence: keeping the guest's numbers
      // would give the account two "goal #1"s, and a judge is asked about a
      // number. Recomputed per goal because each one added changes the next.
      goalNumber: nextGoalNumber(owner.id, goals),
    });
  }
  if (goals.length) saveGoals(goals);

  const consents = getConsents();
  const known = new Set(consents.map((c) => c.id));
  let added = false;
  for (const consent of carry.consents) {
    if (known.has(consent.id)) continue;
    consents.push({ ...consent, ownerUserId: owner.id });
    added = true;
  }
  if (added) saveConsents(consents);
  ensureGoalNumbers();
}

/**
 * Take on the account the server just described: replace this device's cache
 * with the account's document, make sure a local `User` row matches it, and
 * start syncing from there.
 *
 * The `User` row is part of the document, so on a second device it usually
 * arrives with everything else — name, avatar, theme, who they follow. It is
 * only built here when the document has no row for the account, which is a
 * brand-new sign-up or an account whose document was never written.
 */
function adoptAccount(
  result: AuthResult,
  carry: Carry | null,
  fallback?: { name?: string; accountType?: 'standard' | 'trainer' },
): User {
  cloud.start(result.state);

  const users = getUsers();
  const existing = users.find((u) => u.id === result.account.id);
  const user: User =
    existing ??
    blankUser({
      id: result.account.id,
      name: result.account.name || fallback?.name || 'Friend',
      email: result.account.email,
      accountType: result.account.accountType || fallback?.accountType || 'standard',
    });

  // Fields the SERVER owns, refreshed either way: the address is what was logged
  // in with, and the verification stamp is the server's to grant.
  user.email = result.account.email || user.email;
  user.password = '';
  user.isGuest = false;
  user.deleted = false;
  if (result.account.emailVerifiedAt) user.emailVerifiedAt = result.account.emailVerifiedAt;

  saveUsers(existing ? users.map((u) => (u.id === user.id ? user : u)) : [...users, user]);
  write(KEYS.session, user.id);

  if (carry) absorbCarry(carry, user);
  seedSocial(user.id);
  return normalizeUser(getUsers().find((u) => u.id === user.id) ?? user);
}

/**
 * Forget the account's data on this device.
 *
 * Signing out of a real account should leave nothing behind — the data is on
 * the server, so there is nothing to lose and someone else may use this phone
 * next. Only done when there IS a server to have left it with.
 */
async function clearLocalAccountData(): Promise<void> {
  await cloud.stop();
  if (backendEnabled()) cloud.adopt({}, 0);
  write(KEYS.session, null);
}

/* ─────────────────────────────────────────────── Password reset ── */

/**
 * Email a reset link. Resolves whether or not the address has an account, so
 * this screen cannot be used to test who is registered.
 */
export async function startPasswordReset(email: string): Promise<void> {
  return requestPasswordReset(email);
}

/**
 * Spend a reset link and set the new password.
 *
 * One call, and it signs the device in on success: the person has just proved
 * they can open the mailbox and chosen a password, so sending them to a login
 * form to type it again proves nothing. The reset link now works from ANY
 * device — it changes the password on the account, not on a phone.
 */
export async function applyPasswordReset(token: string, password: string): Promise<User> {
  const carry = captureCarry();
  const result = await remoteApplyPasswordReset(token, password);
  const user = adoptAccount(result, carry);
  logAudit({ actorId: user.id, actionType: 'password_reset', entityType: 'user', entityId: user.id });
  return user;
}

/**
 * Set a new password on the device-local account for an address.
 *
 * Only reachable in the no-backend fallback, where there is no server to hold
 * the account and nothing to change if it isn't here.
 */
export async function setPasswordForEmail(email: string, password: string): Promise<void> {
  await delay();
  const normalized = email.trim().toLowerCase();
  const users = getUsers();
  const user = users.find((u) => u.email === normalized && !u.deleted);
  if (!user) throw new Error('There is no Comitra account for that address on this device.');
  saveUsers(users.map((u) => (u.id === user.id ? { ...u, password } : u)));
  logAudit({ actorId: user.id, actionType: 'password_reset', entityType: 'user', entityId: user.id });
}

/**
 * Create an account.
 *
 * Sign-up asks for an email and nothing else contactable — no phone number.
 * `ticket` is the receipt `verifyEmailCode` hands back when the emailed code was
 * accepted; the server insists on one whenever email verification is switched
 * on, so an address cannot be registered by someone who never opened its inbox.
 */
export async function register(
  name: string,
  email: string,
  password: string,
  accountType: 'standard' | 'trainer' = 'standard',
  ticket?: string,
): Promise<User> {
  const normalized = email.trim().toLowerCase();
  const displayName = name.trim() || 'Friend';

  if (backendEnabled()) {
    const carry = captureCarry();
    const result = await remoteRegister({
      name: displayName,
      email: normalized,
      password,
      accountType,
      ticket,
    });
    const user = adoptAccount(result, carry, { name: displayName, accountType });
    logAudit({ actorId: user.id, actionType: 'account_registered', entityType: 'user', entityId: user.id });
    return user;
  }

  await delay();
  const users = getUsers();
  if (users.some((u) => u.email === normalized && !u.deleted)) {
    throw new Error('An account with this email already exists.');
  }
  const user = blankUser({
    id: uid('user'),
    name: displayName,
    email: normalized,
    password,
    accountType,
    ...(ticket ? { emailVerifiedAt: new Date().toISOString() } : {}),
  });
  users.push(user);
  saveUsers(users);
  write(KEYS.session, user.id);
  seedSocial(user.id);
  logAudit({ actorId: user.id, actionType: 'account_registered', entityType: 'user', entityId: user.id });
  return normalizeUser(getUsers().find((u) => u.id === user.id) ?? user);
}

export async function login(email: string, password: string): Promise<User> {
  const normalized = email.trim().toLowerCase();

  if (backendEnabled()) {
    const carry = captureCarry();
    const result = await remoteLogin(normalized, password);
    return adoptAccount(result, carry);
  }

  await delay();
  const users = getUsers();
  const user = users.find((u) => u.email === normalized && !u.deleted);
  if (!user || user.password !== password) throw new Error('Invalid email or password.');
  write(KEYS.session, user.id);
  seedSocial(user.id);
  return normalizeUser(getUsers().find((u) => u.id === user.id) ?? user);
}

export async function logout(): Promise<void> {
  // Push anything still unsaved BEFORE the session is given up, or the last
  // thing the person did before signing out is the one thing that never syncs.
  await clearLocalAccountData();
  await remoteLogout();
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

/**
 * `accessToken` is Google's, and it is what the server actually signs in on: the
 * address below is only used for the offline/local path, because a server that
 * believed a client-supplied address would hand over any account to anyone who
 * typed its owner's email.
 */
export async function socialLogin(profile: {
  email: string;
  name: string;
  avatar?: string;
  accessToken: string;
}): Promise<User> {
  const email = profile.email.trim().toLowerCase();
  if (!email) throw new Error('No email address was returned by the provider.');
  const name = profile.name.trim() || email.split('@')[0];

  if (backendEnabled()) {
    const carry = captureCarry();
    const result = await remoteSocialLogin({ name, accessToken: profile.accessToken });
    return adoptAccount(result, carry, { name });
  }

  await delay(120);
  const users = getUsers();
  const existing = users.find((u) => u.email === email && !u.deleted);
  if (existing) {
    write(KEYS.session, existing.id);
    seedSocial(existing.id);
    return normalizeUser(getUsers().find((u) => u.id === existing.id) ?? existing);
  }
  const user = blankUser({
    id: uid('user'),
    name,
    email,
    avatar: profile.avatar || 'preset-1',
  });
  users.push(user);
  saveUsers(users);
  write(KEYS.session, user.id);
  seedSocial(user.id);
  return normalizeUser(getUsers().find((u) => u.id === user.id) ?? user);
}

/**
 * Fold a guest's goals into a real account after auth.
 *
 * Signing in normally handles this itself (see `captureCarry`), because it has
 * to: adopting the account's document replaces this device's cache, so the
 * guest's rows have to be picked up BEFORE that happens rather than afterwards.
 * This remains for the device-local fallback, and is a no-op once the guest is
 * already gone.
 */
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
  logAudit({ actorId: userId, actionType: 'account_deleted', entityType: 'user', entityId: userId });

  if (backendEnabled() && signedInRemotely()) {
    // Stop syncing WITHOUT a final push: the account is about to stop existing,
    // and a push racing the delete would just 401.
    await cloud.stop({ push: false });
    await remoteDeleteAccount();
    cloud.adopt({}, 0);
    write(KEYS.session, null);
    return;
  }

  await delay();
  saveUsers(getUsers().map((u) => (u.id === userId ? { ...u, deleted: true } : u)));
  write(KEYS.session, null);
}

export async function getSessionUser(): Promise<User | null> {
  const id = read<string | null>(KEYS.session, null);
  if (!id) return null;
  const user = getUsers().find((u) => u.id === id) ?? null;
  return user ? normalizeUser(user) : null;
}

/**
 * Who this device is signed in as, according to the SERVER. The cold-start call.
 *
 * Three outcomes, and the difference matters:
 *   • an account — its document is pulled and adopted, which is what makes a
 *     fresh install of the app show everything the person already has;
 *   • nobody — the session token is gone or was revoked, so any account left
 *     over in the local cache is signed out rather than silently trusted;
 *   • the server could not be asked — keep working with what is on the device.
 *     Signing someone out because their train went into a tunnel would be a far
 *     worse bug than showing them data that is a few minutes stale.
 */
export async function bootstrapSession(): Promise<User | null> {
  if (!backendEnabled()) return getSessionUser();

  let result: AuthResult | null;
  try {
    result = await remoteSession();
  } catch (err) {
    console.warn('[api] could not reach the server on startup, using this device\'s copy:', err);
    return getSessionUser();
  }

  if (result) return adoptAccount(result, captureCarry());

  // No server session. A guest is fine to keep — it never had one. A real
  // account without one is a leftover (revoked, or created before accounts
  // moved to the server), and must not look signed in.
  const local = await getSessionUser();
  if (local && !local.isGuest) {
    write(KEYS.session, null);
    return null;
  }
  return local;
}

/* ──────────────────────────────────── Losing the session while open ── */

const signedOutListeners = new Set<() => void>();

/**
 * Told when the server stops accepting this device's session — a password reset
 * done elsewhere, an account deleted from another device, an expired token.
 *
 * The app has to react rather than carry on: without this it would keep letting
 * someone edit goals that no longer have anywhere to be saved.
 */
export function onSignedOut(fn: () => void): () => void {
  signedOutListeners.add(fn);
  return () => signedOutListeners.delete(fn);
}

cloud.onSessionLost(() => {
  cloud.adopt({}, 0);
  write(KEYS.session, null);
  for (const fn of signedOutListeners) {
    try {
      fn();
    } catch (err) {
      console.warn('[api] sign-out listener failed:', err);
    }
  }
});

export async function updateUser(user: User): Promise<User> {
  await delay(80);
  const before = getUsers().find((u) => u.id === user.id);
  const saved = normalizeUser(persistUser(user));
  // The account row carries its own copy of the display name, used as the
  // fallback when a device has the account but not yet its document.
  if (before && before.name !== saved.name && !saved.isGuest) void remoteRename(saved.name);
  return saved;
}

/* ───────────────────────────────────────────────────── Goal lifecycle ── */

export async function listGoals(userId: string): Promise<Goal[]> {
  await delay(80);
  resolveExpired();
  await pullRunningGoals(userId);
  resolveExpired();
  return getGoals()
    .filter((g) => g.userId === userId)
    .sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
}

/**
 * Refresh the owner's running judged goals from the shared store, so a decision
 * their judge made on another phone shows up here.
 *
 * Each goal is fetched by its own id + token: there is no "list this owner's
 * goals" call anywhere, by design. A user id travels inside invite links, and a
 * lookup keyed on it would turn one leaked link into a list of everything that
 * person is working on.
 */
async function pullRunningGoals(userId: string): Promise<void> {
  if (!supabaseEnabled()) return;
  const goals = getGoals();
  const mine = goals.filter(
    (g) => g.userId === userId && !g.noJudge && !TERMINAL_STATUSES.includes(g.status),
  );

  // Goals set before this device ever had a shared store were never published,
  // so their judge links would open nothing. Publish them once, here, rather
  // than making the owner re-create goals they already committed to.
  const unpublished = mine.filter((g) => !g.updatedAt);
  if (unpublished.length > 0) {
    for (const goal of unpublished) {
      goal.updatedAt = new Date().toISOString();
      pushGoal(goal);
    }
    write(KEYS.goals, goals);
    await flushGoalSync();
  }

  // Bounded: a dashboard load must not fan out to dozens of requests.
  await Promise.all(mine.slice(0, 12).map((g) => pullGoal(g.id)));
}

export async function getGoal(id: string): Promise<Goal | null> {
  resolveExpired();
  const local = getGoals().find((g) => g.id === id) ?? null;
  if (local && !local.noJudge && !TERMINAL_STATUSES.includes(local.status)) {
    await pullGoal(id);
    resolveExpired();
  }
  return getGoals().find((g) => g.id === id) ?? local;
}

export async function getGoalByToken(token: string): Promise<Goal | null> {
  resolveExpired();
  return getGoals().find((g) => g.shareToken === token || g.judge.acceptToken === token) ?? null;
}

/**
 * A recipient is a FRIEND — someone the owner follows who follows them back —
 * and nothing else. There is no contact field any more: the message goes to
 * their account (see `src/lib/push.ts`), so Comitra never holds a number or an
 * address for the person who might be told about a missed goal.
 */
export interface RecipientInput {
  /** The friend's account id. Required: this is who the message is addressed to. */
  recipientUserId: string;
  /** Their display name, copied so the owner's own screens read normally. */
  name: string;
}

export interface CreateGoalInput {
  userId: string;
  creatorName: string;
  creatorAvatar?: string;
  /** Private to the owner: never sent to the judge or to recipients. */
  title: string;
  /** Private to the owner: never sent to the judge or to recipients. */
  description: string;
  requiredActionsCount: number;
  startsAt?: string; // ISO
  deadlineAt: string; // ISO
  messageTone: MessageTone;
  ackNotifyConsent: boolean;
  /**
   * The friend who will judge this goal. Omit it entirely for a solo, self-
   * tracked goal. A judge is an ACCOUNT now — there is no address to type and
   * nobody to invite: you pick someone you are already friends with.
   */
  judge?: { judgeUserId: string; name: string };
  recipients: RecipientInput[];
  /** Penalty: block an app for a while if the goal is not completed. */
  appBlock?: AppBlockPenalty;
}

/* ────────────────────────────────────────────────── Goal numbering ── */

/** The next free per-owner goal number (1-based). */
function nextGoalNumber(ownerUserId: string, goals = getGoals()): number {
  const max = goals
    .filter((g) => g.userId === ownerUserId)
    .reduce((m, g) => Math.max(m, g.goalNumber ?? 0), 0);
  return max + 1;
}

/** The number the user's next goal will get, shown while they set it up. */
export async function getNextGoalNumber(userId: string): Promise<number> {
  await delay(40);
  ensureGoalNumbers();
  return nextGoalNumber(userId);
}

/**
 * Give a number to any goal saved before goal numbering existed, so a judge or a
 * recipient always has something to refer to. Ordered by creation time per owner.
 */
function ensureGoalNumbers(): void {
  const goals = getGoals();
  const missing = goals.filter((g) => !g.goalNumber);
  if (missing.length === 0) return;
  const nextByOwner = new Map<string, number>();
  for (const g of [...missing].sort((a, b) => +new Date(a.createdAt) - +new Date(b.createdAt))) {
    const n = nextByOwner.get(g.userId) ?? nextGoalNumber(g.userId, goals);
    g.goalNumber = n;
    nextByOwner.set(g.userId, n + 1);
  }
  saveGoals(goals);
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
  const consents = getConsents();
  const existing = consents.find(
    (c) => c.ownerUserId === ownerUserId && c.recipientUserId === r.recipientUserId,
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
    // Always internal now: a recipient is an account, never a number.
    channel: 'internal',
    recipientUserId: r.recipientUserId,
    consentStatus: 'pending',
    inviteToken: uuid(),
    createdAt: new Date().toISOString(),
  };
  consents.push(consent);
  saveConsents(consents);
  logAudit({ actorId: ownerUserId, actionType: 'recipient_invited', entityType: 'recipient_consent', entityId: consent.id, metadata: { channel: consent.channel } });
  // Notification #1: ask the recipient to consent BEFORE any message is ever
  // sent. It reaches their app, carrying the token their accept screen opens.
  const owner = getUsers().find((u) => u.id === ownerUserId);
  const ownerName = owner?.name ?? 'A Comitra user';
  const entry = queueOutbox({
    kind: 'recipient_consent_request',
    to: 'recipient',
    channel: 'internal',
    body: recipientInviteMessage(ownerName),
  });
  void sendPush({
    id: entry.id,
    toUserId: r.recipientUserId,
    fromUserId: ownerUserId,
    kind: 'recipient_consent_request',
    payload: {
      ownerName,
      consentToken: consent.inviteToken,
      // The id is what the friend's answer comes back quoting: their device
      // never holds the consent row itself, only this reference to it.
      consentId: consent.id,
      body: recipientInviteMessage(ownerName),
    },
  });
  return consent;
}

/* ─────────────────────────────────── Post-failure reflection ── */

/** Every reflection answer must be at least this long. */
export const REFLECTION_MIN_CHARS = 20;

/** Statuses that count as "you missed this goal" and owe a reflection. */
const FAILED_STATUSES: GoalStatus[] = ['failed_pending_notification', 'failed_notified'];

function getReflections(): GoalReflection[] {
  return read<GoalReflection[]>(KEYS.goalReflections, []);
}
function saveReflections(list: GoalReflection[]) {
  write(KEYS.goalReflections, list);
}

/** The reflection written for a goal, if the user has already answered. */
export async function getGoalReflection(goalId: string): Promise<GoalReflection | null> {
  await delay(40);
  return getReflections().find((r) => r.goalId === goalId) ?? null;
}

/**
 * Missed goals this user still owes a reflection for, oldest first. While this
 * is non-empty the user cannot create a new goal (see `createGoal`).
 */
export async function listUnreflectedGoals(userId: string): Promise<Goal[]> {
  await delay(60);
  resolveExpired();
  return unreflectedGoals(userId);
}

function unreflectedGoals(userId: string): Goal[] {
  const answered = new Set(getReflections().filter((r) => r.userId === userId).map((r) => r.goalId));
  return getGoals()
    .filter((g) => g.userId === userId && FAILED_STATUSES.includes(g.status) && !answered.has(g.id))
    .sort((a, b) => +new Date(a.failedAt ?? a.deadlineAt) - +new Date(b.failedAt ?? b.deadlineAt));
}

/**
 * Answer the two questions owed after a missed goal. Both answers are private to
 * the user: no judge and no recipient ever sees them.
 */
export async function submitGoalReflection(
  goalId: string,
  userId: string,
  whyFailed: string,
  nextTime: string,
): Promise<GoalReflection> {
  await delay();
  const goal = getGoals().find((g) => g.id === goalId);
  if (!goal) throw new Error('Goal not found.');
  if (goal.userId !== userId) throw new Error('Only the goal owner can answer these questions.');
  if (!FAILED_STATUSES.includes(goal.status)) throw new Error('This goal was not missed.');
  const why = whyFailed.trim();
  const next = nextTime.trim();
  if (why.length < REFLECTION_MIN_CHARS || next.length < REFLECTION_MIN_CHARS) {
    throw new Error(`Write at least ${REFLECTION_MIN_CHARS} characters in both answers.`);
  }

  const list = getReflections().filter((r) => r.goalId !== goalId);
  const record: GoalReflection = {
    id: uid('refl'),
    goalId,
    userId,
    whyFailed: why,
    nextTime: next,
    createdAt: new Date().toISOString(),
  };
  list.push(record);
  saveReflections(list);
  logAudit({ actorId: userId, actionType: 'goal_reflection_written', entityType: 'goal', entityId: goalId });
  return record;
}

/**
 * Create + submit a goal. Requires an active subscription or live trial, and no
 * outstanding reflection on a missed goal. Invites the judge and each recipient
 * (reusing standing consents). Never activates until the judge accepts AND every
 * recipient has an accepted consent.
 */
export async function createGoal(input: CreateGoalInput): Promise<Goal> {
  await delay();
  const owner = getUsers().find((u) => u.id === input.userId);
  if (!owner) throw new Error('User not found.');
  if (!hasEntitlement(normalizeUser(owner))) {
    throw new Error('A subscription is required to create goals.');
  }
  // A missed goal must be reflected on before a new one can be started.
  resolveExpired();
  if (unreflectedGoals(input.userId).length > 0) {
    throw new Error(
      'Answer the two questions about your missed goal before you set a new one.',
    );
  }
  const recips = input.recipients.filter((r) => !!r.recipientUserId);
  // Recipients are optional now: but if there are any, the notify consent is required.
  if (recips.length > 0 && !input.ackNotifyConsent) {
    throw new Error('You must acknowledge that recipients may be messaged on failure.');
  }
  if (recips.length > MAX_RECIPIENTS_PER_GOAL) {
    throw new Error(
      MAX_RECIPIENTS_PER_GOAL === 1
        ? 'A goal can have only one recipient.'
        : `You can add at most ${MAX_RECIPIENTS_PER_GOAL} recipients.`,
    );
  }
  // Anti-spam: count how many of these are brand-new invites.
  const newInvites = recips.filter(
    (r) => !getConsents().some((c) => c.ownerUserId === input.userId && c.recipientUserId === r.recipientUserId),
  ).length;
  if (invitesSentToday(input.userId) + newInvites > MAX_INVITES_PER_DAY) {
    throw new Error(`Daily invite limit reached (${MAX_INVITES_PER_DAY}/day). Try again tomorrow.`);
  }

  const consents = recips.map((r) => upsertConsent(input.userId, r));

  const noJudge = !input.judge;
  if (input.judge && input.judge.judgeUserId === input.userId) {
    throw new Error('You cannot be the judge of your own goal.');
  }
  const judge: GoalJudge = input.judge
    ? {
        name: input.judge.name.trim() || 'Judge',
        channel: 'internal',
        judgeUserId: input.judge.judgeUserId,
        status: 'pending',
        // Written, never read: see the note on `GoalJudge.acceptToken`.
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

  const goals = getGoals();
  const goal: Goal = {
    id: uuid(),
    userId: input.userId,
    goalNumber: nextGoalNumber(input.userId, goals),
    creatorName: input.creatorName.trim() || 'Someone',
    creatorAvatar: input.creatorAvatar,
    creatorDeviceId: getDeviceId(),
    title: input.title.trim(),
    description: input.description.trim(),
    // Always starts private; only a FINISHED goal can be published, from its
    // detail screen (see `setGoalVisibility`).
    isPublic: false,
    requiredActionsCount: Math.max(1, input.requiredActionsCount || 1),
    plannedActions: buildPlannedActions(input),
    startsAt: input.startsAt,
    deadlineAt: input.deadlineAt,
    status: 'waiting_for_judge_acceptance',
    messageTone: input.messageTone,
    ackNotifyConsent: input.ackNotifyConsent,
    noJudge,
    // The app-block penalty works for solo AND judged goals: a judged goal fires
    // it when the judge marks the goal not completed (see applyJudgeDecision).
    appBlock: input.appBlock,
    judge,
    recipients: consents.map((c) => ({ consentId: c.id })),
    shareToken: judge.acceptToken,
    createdAt: new Date().toISOString(),
  };

  goals.push(recompute(goal));
  saveGoals(goals);


  if (recips.length > 0) {
    logLegalAcceptance({ type: 'goal_notify_ack', userId: input.userId, goalId: goal.id });
  }
  logAudit({ actorId: input.userId, actionType: 'goal_created', entityType: 'goal', entityId: goal.id, metadata: { tone: goal.messageTone, recipients: consents.length } });

  // The judge has to be able to open this the moment they are asked, so it must
  // reach the shared store BEFORE the message that tells them about it.
  await flushGoalSync();

  // Asking them is a message in their conversation, with the accept/decline
  // buttons on it. It carries the goal NUMBER and nothing else — the same rule
  // as everywhere: the owner tells their judge what the goal is themselves.
  if (input.judge) {
    await sendChatMessage({
      toUserId: input.judge.judgeUserId,
      kind: 'request',
      payload: { request: 'judge_invite', goalId: goal.id, goalNumber: goal.goalNumber },
    });
  }
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
 * Show ONE finished goal's title on the owner's public profile (or hide it
 * again). Deliberately narrow:
 *  • per goal: it never touches the owner's other goals;
 *  • only once the goal is OVER, so a running goal can never be broadcast;
 *  • profile only: messages and the judge view stay content-free either way.
 */
export async function setGoalVisibility(goalId: string, userId: string, isPublic: boolean): Promise<Goal> {
  await delay(60);
  resolveExpired();
  const goals = getGoals();
  const goal = goals.find((g) => g.id === goalId);
  if (!goal) throw new Error('Goal not found.');
  if (goal.userId !== userId) throw new Error('Only the goal owner can change who sees this goal.');
  if (!TERMINAL_STATUSES.includes(goal.status)) {
    throw new Error('You can only make a goal public once it is finished.');
  }
  goal.isPublic = isPublic;
  saveGoals(goals);
  logAudit({ actorId: userId, actionType: isPublic ? 'goal_made_public' : 'goal_made_private', entityType: 'goal', entityId: goal.id });
  return goal;
}

/**
 * Statuses where a goal is over and its result is final. Only these can be
 * deleted from history, and only these can be made public.
 */
export const TERMINAL_STATUSES: GoalStatus[] = [
  'completed',
  'failed_notified',
  'cancelled',
  'expired_without_judge_decision',
];

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
  // has a judge: even before it starts, is cancelled by that judge, once the
  // creator asks them. See requestCancel / judgeCancelGoal.
  if (!goal.noJudge) {
    throw new Error('A goal with a judge can only be cancelled by the judge, once you ask them to.');
  }
  if (!CANCELLABLE_STATUSES.includes(goal.status)) throw new Error('This goal cannot be cancelled now.');
  goal.status = 'cancelled';
  goal.cancelledAt = new Date().toISOString();
  liftCommitmentBlock(goal); // must mutate BEFORE the save, or it is not persisted
  saveGoals(goals);
  cancelAppBlock(penaltyBlockId(goal.id)); // solo goal cancelled in time → no penalty
  logAudit({ actorId: goal.userId, actionType: 'goal_cancelled', entityType: 'goal', entityId: goal.id });
  return goal;
}

/**
 * The creator asks their judge to change or cancel a running goal (they can't
 * cancel a judged goal themselves). The judge can only cancel after this.
 *
 * Comitra sends nothing: the owner passes on the "ask for a change" link and
 * opening it is what records the request. No secret code is involved in
 * cancelling.
 */
export async function requestCancel(goalId: string, userId: string): Promise<Goal> {
  await delay(80);
  const goals = getGoals();
  const goal = goals.find((g) => g.id === goalId);
  if (!goal) throw new Error('Goal not found.');
  if (goal.userId !== userId) throw new Error('Only the goal owner can ask to cancel.');
  if (goal.noJudge) throw new Error('This goal has no judge, so you can cancel it yourself.');
  if (!CANCELLABLE_STATUSES.includes(goal.status)) throw new Error('This goal cannot be cancelled now.');
  goal.cancelRequested = true;
  saveGoals(goals);
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
  if (!goal.noJudge) throw new Error('This goal has a judge, so only the judge can decide it.');
  if (goal.status !== 'active') throw new Error('Only an active goal can be marked completed.');
  const at = new Date().toISOString();
  goal.status = 'completed';
  goal.completedAt = at;
  goal.judge = { ...goal.judge, decision: 'completed', decisionAt: at };
  liftCommitmentBlock(goal); // must mutate BEFORE the save, or it is not persisted
  saveGoals(goals);
  cancelAppBlock(penaltyBlockId(goal.id)); // completed in time → no penalty
  logAudit({ actorId: userId, actionType: 'solo_goal_completed', entityType: 'goal', entityId: goal.id });
  return goal;
}

/** Creator marks their own solo (judge-less) goal as NOT completed. */
export async function failSoloGoal(goalId: string, userId: string): Promise<Goal> {
  await delay();
  const goals = getGoals();
  const goal = goals.find((g) => g.id === goalId);
  if (!goal) throw new Error('Goal not found.');
  if (goal.userId !== userId) throw new Error('Only the goal owner can decide this goal.');
  if (!goal.noJudge) throw new Error('This goal has a judge, so only the judge can decide it.');
  if (goal.status !== 'active') throw new Error('Only an active goal can be marked not completed.');
  const at = new Date().toISOString();
  goal.status = 'failed_notified';
  goal.failedAt = at;
  goal.judge = { ...goal.judge, decision: 'not_completed', decisionAt: at };
  liftCommitmentBlock(goal); // must mutate BEFORE the save, or it is not persisted
  // Saying "I didn't do it" is what costs the app block the user chose when they
  // set the goal. Nothing else starts it — not even the deadline running out.
  applyAppBlockPenalty(goal);
  saveGoals(goals);
  logAudit({ actorId: userId, actionType: 'solo_goal_failed', entityType: 'goal', entityId: goal.id });
  return goal;
}

/**
 * Change a goal's deadline. The deadline is the ONE thing the owner may edit
 * after a goal is set: the goal itself, its judge, its recipients and its
 * penalty are the commitment, and editing those would empty it out. A judged
 * goal that has already been decided is closed.
 */
export async function updateGoalDeadline(goalId: string, userId: string, deadlineAt: string): Promise<Goal> {
  await delay(80);
  const goals = getGoals();
  const goal = goals.find((g) => g.id === goalId);
  if (!goal) throw new Error('Goal not found.');
  if (goal.userId !== userId) throw new Error('Only the goal owner can change the deadline.');
  if (TERMINAL_STATUSES.includes(goal.status)) throw new Error('This goal is finished, so its deadline is fixed.');
  if (goal.judge?.decision) throw new Error('Your judge has already decided this goal.');
  const at = new Date(deadlineAt);
  if (Number.isNaN(at.getTime())) throw new Error('That date and time is not valid.');
  if (at.getTime() <= Date.now()) throw new Error('The new deadline must be in the future.');
  goal.deadlineAt = at.toISOString();
  // A live "blocked while you work" lock runs until the goal ends, so it follows
  // the deadline rather than unlocking early or outliving the goal.
  if (goal.commitmentBlock && !goal.commitmentBlock.liftedAt) {
    goal.commitmentBlock = { ...goal.commitmentBlock, untilAt: goal.deadlineAt };
    const b = goal.commitmentBlock;
    void scheduleAppBlock(commitmentBlockId(goal.id), b.packageName, b.appLabel, at.getTime());
  }
  saveGoals(goals);
  logAudit({ actorId: userId, actionType: 'goal_deadline_changed', entityType: 'goal', entityId: goal.id });
  await flushGoalSync(); // the judge's copy shows the new deadline
  return goal;
}

/**
 * The creator asks their judge to decide the goal before the deadline. This is
 * the ONLY way a judge may decide early.
 *
 * Comitra does not message the judge about it: the owner sends them the "ask for
 * a decision" link themselves (see `judgeLink(goal, 'decision')`), and opening
 * that link is what records the request. See `applyJudgeLinkRequest`.
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
  logAudit({ actorId: userId, actionType: 'early_decision_requested', entityType: 'goal', entityId: goal.id });
  return goal;
}

export async function deleteGoal(id: string): Promise<void> {
  await delay(80);
  const goal = getGoals().find((g) => g.id === id);
  if (!goal) return;
  if (!TERMINAL_STATUSES.includes(goal.status)) {
    throw new Error('Only finished goals can be removed from history.');
  }
  saveGoals(getGoals().filter((g) => g.id !== id));
}

/**
 * Housekeeping pass run before goals are read.
 *
 * A passing deadline decides NOTHING, for a solo goal as much as a judged one.
 * Both stay `active` past it until somebody says how it went — the owner on a
 * solo goal, the judge on a judged one — so they keep showing under Active
 * goals and stay out of the history and every leaderboard until then. Nothing
 * here ever starts an app block: that is the verdict's job alone, in
 * `applyAppBlockPenalty`, which is what "not completed" costs.
 *
 * All that is left to do here is back-fill goal numbers on old rows.
 */
function resolveExpired() {
  ensureGoalNumbers();
}

/* ─────────────────────────────────── Judge codes / credentials ── */

/** Loose on purpose: the authority on whether an address works is the mailbox. */
const EMAIL_SHAPE = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]{2,}$/;

/** Trim + lower-case, the same normalisation `register` and `login` apply. */
export function normalizeEmail(email: string): string {
  return (email ?? '').trim().toLowerCase();
}

/** Whether an address is worth sending a code to at all. */
export function emailLooksValid(email: string): boolean {
  const value = normalizeEmail(email);
  return value.length >= 5 && value.length <= 254 && EMAIL_SHAPE.test(value);
}

/**
 * What the sign-up form should do about the email code step — see
 * `EmailVerifyMode` in lib/email.ts for why this is not a boolean.
 *
 * `VITE_EMAIL_VERIFY=off` is the one deliberate escape hatch, and it is checked
 * here rather than in lib/email.ts so the kill switch cannot be confused with
 * "the backend happens to be down". Without it, a misconfigured SES would lock
 * every new person out of the app with no way back in.
 */
export type { EmailVerifyMode, OtpPurpose };

export async function emailVerificationMode(): Promise<EmailVerifyMode> {
  if (import.meta.env.VITE_EMAIL_VERIFY?.trim().toLowerCase() === 'off') return 'disabled';
  return emailOtpMode();
}

/**
 * Email a 6-digit verification code to prove the address belongs to the person
 * entering it. The code is generated, hashed and checked by our own backend; it
 * is valid for 7 minutes, allows 5 attempts, and can be re-sent after 30s.
 *
 * `purpose` says which flow is asking. The email is identical either way — the
 * same template, the same six digits — but the codes are separate, so accepting
 * a judge invite never eats the code someone is mid-way through typing into the
 * sign-up form on the same address.
 */
export async function startEmailVerification(email: string, purpose: OtpPurpose = 'signup'): Promise<void> {
  if (!emailLooksValid(email)) throw new Error('Enter a valid email address.');
  await sendEmailOtp(normalizeEmail(email), purpose);
}

/**
 * Check the 6-digit code that was emailed. Throws if it's wrong or expired.
 *
 * Returns the backend's receipt for the check, which `register` must present.
 * Undefined for a judge invite (which creates no account) and wherever there is
 * no backend to have issued one.
 */
export async function verifyEmailCode(
  email: string,
  code: string,
  purpose: OtpPurpose = 'signup',
): Promise<string | undefined> {
  const digits = (code ?? '').replace(/\D/g, '');
  if (digits.length < 4) throw new Error('Enter the code from the email.');
  return verifyEmailOtp(normalizeEmail(email), digits, purpose);
}

/**
 * Whether a judge's address gets confirmed with an emailed code.
 *
 * Same answer as the sign-up form's: it is on exactly when the backend can send
 * email at all. There is deliberately no way to force it on — showing a "we
 * emailed you a code" screen no backend can follow through on would strand
 * every judge at a code that never arrives.
 */
/* ─────────────────────────────────── Commitment app block ── */

/**
 * A commitment block can only be set on a goal that finishes soon. Locking an app
 * away for months is not a commitment device, it's a footgun.
 */
export const COMMITMENT_BLOCK_MAX_DAYS = 14;

/** Statuses during which a goal is running and a block may be switched on. */
const BLOCKABLE_STATUSES: GoalStatus[] = ['active'];

/**
 * Whether the "block an app until I finish this" option should be offered:
 * the goal is running, its deadline is still ahead but no further away than
 * {@link COMMITMENT_BLOCK_MAX_DAYS}, and no block is already live.
 */
export function canSetCommitmentBlock(goal: Goal, now = Date.now()): boolean {
  if (!BLOCKABLE_STATUSES.includes(goal.status)) return false;
  if (isCommitmentBlockLive(goal, now)) return false;
  const due = +new Date(goal.deadlineAt);
  return due > now && due - now <= COMMITMENT_BLOCK_MAX_DAYS * 86_400_000;
}

/** True while a commitment block is actually in force. */
export function isCommitmentBlockLive(goal: Goal, now = Date.now()): boolean {
  const b = goal.commitmentBlock;
  return !!b && !b.liftedAt && now < +new Date(b.untilAt);
}

/**
 * Block an app until this goal ends. The user has already confirmed they
 * understand they cannot use it until the goal is completed or over, there is
 * deliberately no "undo": that is the entire point of the feature. The only ways
 * out are finishing the goal, it being cancelled, or the deadline arriving.
 */
export async function setCommitmentBlock(
  goalId: string,
  userId: string,
  packageName: string,
  appLabel: string,
): Promise<Goal> {
  await delay();
  resolveExpired();
  const goals = getGoals();
  const goal = goals.find((g) => g.id === goalId);
  if (!goal) throw new Error('Goal not found.');
  if (goal.userId !== userId) throw new Error('Only the goal owner can block an app.');
  if (!packageName || !appLabel) throw new Error('Choose an app to block.');
  if (isCommitmentBlockLive(goal)) throw new Error('An app is already blocked for this goal.');
  if (!BLOCKABLE_STATUSES.includes(goal.status)) {
    throw new Error('You can only block an app while the goal is running.');
  }
  const untilMs = +new Date(goal.deadlineAt);
  if (untilMs <= Date.now()) throw new Error('This goal has already reached its deadline.');
  if (untilMs - Date.now() > COMMITMENT_BLOCK_MAX_DAYS * 86_400_000) {
    throw new Error(`You can only do this when the goal ends within ${COMMITMENT_BLOCK_MAX_DAYS} days.`);
  }

  goal.commitmentBlock = {
    packageName,
    appLabel,
    startedAt: new Date().toISOString(),
    untilAt: goal.deadlineAt,
  };
  saveGoals(goals);
  // The native side enforces it and expires it at `untilEpochMs` on its own.
  scheduleAppBlock(commitmentBlockId(goal.id), packageName, appLabel, untilMs);
  logAudit({ actorId: userId, actionType: 'commitment_block_set', entityType: 'goal', entityId: goal.id, metadata: { packageName } });
  return goal;
}

/**
 * Release a commitment block because the goal is over (completed, missed or
 * cancelled). Mutates the goal: the caller persists it.
 */
function liftCommitmentBlock(goal: Goal): void {
  if (!goal.commitmentBlock || goal.commitmentBlock.liftedAt) return;
  goal.commitmentBlock = { ...goal.commitmentBlock, liftedAt: new Date().toISOString() };
  cancelAppBlock(commitmentBlockId(goal.id));
}

/**
 * Start the app-block penalty for a goal that was MARKED not completed. This is
 * the only thing that ever starts it: the owner's own verdict on a solo goal
 * (`failSoloGoal`) or the judge's `not_completed` decision. A deadline going by
 * does not, so an unanswered goal blocks nothing until somebody decides it.
 * Caller persists the goal.
 */
function applyAppBlockPenalty(goal: Goal, now = Date.now()): void {
  if (!goal.appBlock) return;
  const untilMs = now + goal.appBlock.durationMinutes * 60_000;
  goal.appBlockUntil = new Date(untilMs).toISOString();
  scheduleAppBlock(penaltyBlockId(goal.id), goal.appBlock.packageName, goal.appBlock.appLabel, untilMs);
}

/* ─────────────────────────────────────────────── Judge ratings ── */

/** Round to at most two decimal places and clamp into 0-5. */
function normalizeRating(value: number): number {
  const clamped = Math.min(5, Math.max(0, value));
  return Math.round(clamped * 100) / 100;
}

/**
 * The goal owner rates the judge (0-5, up to two decimals). Only judges who have
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

/** Average judge rating (0-5, two decimals) and number of ratings for an account. */
export async function getJudgeRatingSummary(userId: string): Promise<{ avg: number; count: number }> {
  await delay(60);
  const ratings = read<JudgeRating[]>(KEYS.judgeRatings, []).filter((r) => r.judgeUserId === userId);
  if (ratings.length === 0) return { avg: 0, count: 0 };
  const avg = ratings.reduce((s, r) => s + r.value, 0) / ratings.length;
  return { avg: Math.round(avg * 100) / 100, count: ratings.length };
}

/* ─────────────────────────────────────────── Being someone's judge ── */

/**
 * Every goal this account has been asked to judge.
 *
 * The judge's phone has never seen these goals, so the list comes from the
 * shared store, addressed by identity: "the goals whose judge is me". That call
 * could not exist under the old model — a judge proved nothing but possession of
 * a link, so a list keyed on anything would have been a list for whoever held
 * one. It is the reason a judge no longer has to be handed anything at all.
 */
export async function listJudgingGoals(userId: string): Promise<Goal[]> {
  await delay(80);
  if (supabaseEnabled()) {
    for (const row of await remoteListJudgingGoals()) {
      absorbSharedGoal(row.data as SharedGoal);
    }
  }
  return getGoals()
    .filter((g) => !g.noJudge && g.judge.judgeUserId === userId && g.userId !== userId)
    .sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
}

/** The goals waiting on this judge right now — the only ones worth a badge. */
export function judgeActionNeeded(goals: Goal[], now = Date.now()): Goal[] {
  return goals.filter((g) => {
    if (g.judge.decision || TERMINAL_STATUSES.includes(g.status)) return false;
    if (g.judge.status === 'pending') return true;
    if (g.judge.status !== 'accepted') return false;
    if (g.cancelRequested) return true;
    return g.earlyDecisionRequested || Date.now() > +new Date(g.deadlineAt) ? now > 0 : false;
  });
}

function localJudgeGoal(goalId: string, userId: string): { goals: Goal[]; goal: Goal } {
  const goals = getGoals();
  const goal = goals.find((g) => g.id === goalId);
  if (!goal) throw new Error('Goal not found.');
  if (goal.userId === userId) throw new Error('You cannot judge your own goal.');
  if (goal.judge.judgeUserId !== userId) throw new Error('You are not the judge for this goal.');
  return { goals, goal };
}

/**
 * Run one judge action.
 *
 * With a backend, the SERVER decides: it re-reads the stored goal, checks every
 * precondition against it and builds the patch itself, so a judge can write
 * their verdict and nothing else — not a deadline, not a recipient, not a
 * penalty. What comes back is the new shared projection, which is then merged in
 * here like any other pull.
 *
 * Without one (a device-local install, and the test suite) the same transition
 * is applied locally. Both paths have to leave the same state behind, which is
 * why the local branch goes through the same `applyJudgeDecision` the owner's
 * device uses.
 */
async function runJudgeAction(
  goalId: string,
  userId: string,
  action: JudgeAction,
  comment?: string,
): Promise<Goal> {
  const { goals, goal } = localJudgeGoal(goalId, userId);

  if (supabaseEnabled()) {
    const row = await remoteJudgeAct(goalId, action, comment);
    if (row?.data) {
      const merged = absorbSharedGoal(row.data as SharedGoal);
      if (merged) return merged;
    }
    // The server accepted it but sent nothing back to merge: re-read rather
    // than reporting a success this device cannot show.
    return (await getGoal(goalId)) ?? goal;
  }

  const at = new Date().toISOString();
  switch (action) {
    case 'accept':
      if (goal.judge.status !== 'pending') throw new Error('This role was already answered.');
      goal.judge = { ...goal.judge, status: 'accepted', acceptedAt: at };
      saveGoals(goals);
      reevaluateGoals((g) => g.id === goal.id);
      break;
    case 'decline':
      if (goal.judge.status !== 'pending') throw new Error('This role was already answered.');
      goal.judge = { ...goal.judge, status: 'declined', declinedAt: at };
      goal.status = 'cancelled';
      goal.cancelledAt = at;
      saveGoals(goals);
      break;
    case 'cancel':
      if (!goal.cancelRequested) throw new Error('The user has not asked you to cancel this goal.');
      if (!CANCELLABLE_STATUSES.includes(goal.status)) throw new Error('This goal cannot be cancelled now.');
      goal.status = 'cancelled';
      goal.cancelledAt = at;
      liftCommitmentBlock(goal); // must mutate BEFORE the save, or it is not persisted
      saveGoals(goals);
      cancelAppBlock(penaltyBlockId(goal.id));
      break;
    default: {
      const pastDeadline = Date.now() > +new Date(goal.deadlineAt);
      if (goal.status === 'active' && !pastDeadline && !goal.earlyDecisionRequested) {
        throw new Error('You can decide after the deadline, or once they ask you to decide early.');
      }
      applyJudgeDecision(goals, goal, action, comment, { actorId: userId });
      break;
    }
  }
  return getGoals().find((g) => g.id === goal.id) ?? goal;
}

/**
 * Tell the owner, in their conversation, what their judge just did.
 *
 * Best-effort and deliberately un-awaited for failure: the decision is already
 * recorded and will reach them through the goal itself. A message that could not
 * be sent must never make a recorded verdict look like it failed.
 */
async function tellOwner(
  goal: Goal,
  event: 'accepted' | 'declined' | 'completed' | 'not_completed' | 'cancelled',
): Promise<void> {
  if (!goal.userId) return;
  await sendChatMessage({
    toUserId: goal.userId,
    kind: 'system',
    payload: { event, goalId: goal.id, goalNumber: goalNumberOf(goal) },
  });
}

export async function acceptJudgeRole(goalId: string, userId: string): Promise<Goal> {
  await delay();
  const goal = await runJudgeAction(goalId, userId, 'accept');
  logLegalAcceptance({ type: 'judge_role_ack', userId, goalId });
  logAudit({ actorId: userId, actionType: 'judge_accepted', entityType: 'goal', entityId: goalId });
  await tellOwner(goal, 'accepted');
  return goal;
}

export async function declineJudgeRole(goalId: string, userId: string): Promise<Goal> {
  await delay();
  const goal = await runJudgeAction(goalId, userId, 'decline');
  logAudit({ actorId: userId, actionType: 'judge_declined', entityType: 'goal', entityId: goalId });
  await tellOwner(goal, 'declined');
  return goal;
}

/** The verdict. No secret code: being signed in as the judge is the proof. */
export async function judgeDecide(
  goalId: string,
  userId: string,
  decision: JudgeDecision,
  comment?: string,
): Promise<Goal> {
  await delay();
  const goal = await runJudgeAction(goalId, userId, decision, comment);
  logAudit({
    actorId: userId,
    actionType: decision === 'completed' ? 'goal_completed' : 'goal_not_completed',
    entityType: 'goal',
    entityId: goalId,
  });
  await tellOwner(goal, decision);
  return goal;
}

/** Cancel, but only because the owner asked. */
export async function judgeCancel(goalId: string, userId: string): Promise<Goal> {
  await delay();
  const goal = await runJudgeAction(goalId, userId, 'cancel');
  logAudit({ actorId: userId, actionType: 'judge_cancelled_goal', entityType: 'goal', entityId: goalId });
  await tellOwner(goal, 'cancelled');
  return goal;
}

/**
 * What a `completed` / `not_completed` verdict does to a goal.
 *
 * With a backend this same transition is computed in SQL and arrives as a
 * merged row; this is the device-local path (no server configured, and the test
 * suite). Both have to agree, so anything added here has to be added there.
 */
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
  };

  if (decision === 'completed') {
    goal.status = 'completed';
    goal.completedAt = at;
    liftCommitmentBlock(goal); // must mutate BEFORE the save, or it is not persisted
    saveGoals(goals);
    cancelAppBlock(penaltyBlockId(goal.id)); // completed → no penalty
    logAudit({ ...actor, actionType: 'goal_completed', entityType: 'goal', entityId: goal.id });
    return;
  }
  goal.status = 'failed_pending_notification';
  goal.failedAt = at;
  liftCommitmentBlock(goal); // the goal is over either way
  // The judge said it was not completed → this is what starts the app block.
  applyAppBlockPenalty(goal);
  saveGoals(goals);
  logAudit({ ...actor, actionType: 'goal_not_completed', entityType: 'goal', entityId: goal.id });
  dispatchFailureNotifications(goal.id);
}

/* ────────────────────────────────── Asking your judge for something ── */

/**
 * Ask the judge to decide the goal, or to change/cancel it.
 *
 * This is what the two share links used to be. Opening a link WAS the request,
 * which meant the owner had to get one to their judge by hand and the app could
 * honestly say it never messaged anyone. Now the request is a message in their
 * conversation with a button on it — so the flag and the notification are the
 * same act, and neither can happen without the other.
 *
 * The flag is set locally and published first: a judge who taps the button in
 * the message must find a goal that already says they were asked.
 */
export async function askJudge(goalId: string, userId: string, ask: ChatRequest): Promise<Goal> {
  await delay(60);
  const goals = getGoals();
  const goal = goals.find((g) => g.id === goalId);
  if (!goal) throw new Error('Goal not found.');
  if (goal.userId !== userId) throw new Error('Only the goal owner can ask their judge.');
  if (goal.noJudge || !goal.judge.judgeUserId) throw new Error('This goal has no judge.');
  if (goal.judge.decision) throw new Error('Your judge has already decided this goal.');
  if (!CANCELLABLE_STATUSES.includes(goal.status)) throw new Error('This goal is finished.');

  if (ask === 'decision') {
    if (goal.judge.status !== 'accepted') throw new Error('Your judge has not accepted the role yet.');
    goal.earlyDecisionRequested = true;
  } else if (ask === 'edit') {
    if (goal.judge.status !== 'accepted') throw new Error('Your judge has not accepted the role yet.');
    goal.cancelRequested = true;
  }
  saveGoals(goals);
  await flushGoalSync();

  // On a device-local install there is nobody to message — the flag on the goal
  // is the whole record, and the judge reads it from the same phone. Only a
  // configured backend that could not be reached is a real failure to report.
  const sent = await sendChatMessage({
    toUserId: goal.judge.judgeUserId,
    kind: 'request',
    payload: { request: ask, goalId: goal.id, goalNumber: goalNumberOf(goal) },
  });
  if (chatEnabled() && !sent.sent && sent.reason === 'offline') {
    throw new SyncError('offline', "We couldn't reach your judge. Check your connection and try again.");
  }
  logAudit({
    actorId: userId,
    actionType: ask === 'decision' ? 'judge_asked_to_decide' : 'judge_asked_to_change',
    entityType: 'goal',
    entityId: goal.id,
  });
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

/** Trainers a client has accepted: offered as judges when creating a goal. */
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
 * Write back what actually happened to a message once the store has answered.
 *
 * The log row is created optimistically (the dispatch itself is synchronous), so
 * this is what turns "sent" into the truth: `no_device` when nobody has opened
 * the app on that account for a fortnight — the closest thing there is to "they
 * uninstalled Comitra" — or `failed` when the store could not be reached. The
 * message is queued either way and is delivered whenever they come back.
 */
function recordDeliveryOutcome(logId: string, outcome: PushOutcome): void {
  if (outcome === 'sent') return;
  const notifications = getNotifications();
  const log = notifications.find((n) => n.id === logId);
  if (!log) return;
  log.reason = outcome === 'no_device' ? 'no_device' : 'delivery_failed';
  saveNotifications(notifications);
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
  // Recipients' names and numbers live on the OWNER's device only — they are not
  // part of what a judge's phone receives. So when the judge decides on their own
  // device, this must do nothing and leave the goal pending: the owner's device
  // dispatches it the moment it pulls the decision (see `absorbSharedGoal`).
  // Marking it "notified" here would silently bury the message forever.
  const missingConsents = goal.recipients.some((r) => !consents.some((c) => c.id === r.consentId));
  if (missingConsents) return;
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

    const logId = uid('ntf');
    notifications.push({
      id: logId,
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
      // Deliver to the recipient's account. Best-effort and idempotent on the
      // log id, so re-running dispatch can never double-message anyone. The
      // outcome comes back asynchronously and is written onto the log, so the
      // owner's screen can say "they may not have the app any more" rather than
      // claiming a delivery nobody can stand behind.
      if (consent.recipientUserId) {
        void sendPush({
          id: logId,
          toUserId: consent.recipientUserId,
          fromUserId: goal.userId,
          kind: 'goal_not_completed',
          // Who + which numbered goal + the owner's chosen tone. Never the title.
          payload: { ownerName: goal.creatorName, goalNumber: goal.goalNumber, tone: goal.messageTone, body },
        }).then((outcome) => recordDeliveryOutcome(logId, outcome));
      }
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

/**
 * The friend answers a request that reached them in the app.
 *
 * Their device has no consent record to change — consents belong to the person
 * who asked — so this sends the decision back over the same channel the request
 * arrived on. The owner's app applies it the next time it syncs; until then
 * their goal simply stays "waiting for the recipient", which is the truth.
 */
export async function answerRecipientRequest(input: {
  message: PushMessage;
  answeringUserId: string;
  accepted: boolean;
}): Promise<void> {
  const { consentId } = input.message.payload;
  const ownerId = input.message.fromUserId;
  if (!consentId || !ownerId) {
    throw new Error("This request is missing who it came from, so it can't be answered. Ask them to add you again.");
  }
  const ok = await sendPush({
    // Derived from the request's own id, so answering twice cannot queue two
    // answers, and a retry after a dropped connection is free.
    id: `${input.message.id}:answer`,
    toUserId: ownerId,
    fromUserId: input.answeringUserId,
    kind: 'recipient_consent_answer',
    payload: { consentId, accepted: input.accepted },
  });
  if (ok === 'failed') {
    throw new Error("We couldn't reach the server. Check your connection and try again.");
  }
}

/**
 * Apply any answers waiting in this account's inbox, and say which were used.
 *
 * Called on every sync. The consent moves to accepted or revoked, and goals of
 * this owner that were waiting on that person are re-evaluated — which is what
 * finally starts a goal whose recipient has just said yes.
 */
export function absorbConsentAnswers(ownerUserId: string, messages: PushMessage[]): string[] {
  const answers = messages.filter((m) => m.kind === 'recipient_consent_answer');
  if (answers.length === 0) return [];

  const consents = getConsents();
  const consumed: string[] = [];
  let changed = false;

  for (const message of answers) {
    consumed.push(message.id);
    const { consentId, accepted } = message.payload;
    const consent = consents.find((c) => c.id === consentId && c.ownerUserId === ownerUserId);
    // An answer to a consent this device has never heard of is still consumed:
    // leaving it unread would make it come back on every single sync.
    if (!consent || consent.consentStatus === 'revoked') continue;
    consent.consentStatus = accepted ? 'accepted' : 'revoked';
    if (accepted) consent.acceptedAt = message.createdAt;
    else consent.revokedAt = message.createdAt;
    changed = true;
    logAudit({
      actorId: message.fromUserId ?? undefined,
      actionType: accepted ? 'recipient_consent_accepted' : 'recipient_consent_revoked',
      entityType: 'recipient_consent',
      entityId: consent.id,
    });
  }

  if (changed) {
    saveConsents(consents);
    // A goal held up by "waiting for the recipient" can start now.
    reevaluateGoals((g) => g.userId === ownerUserId);
  }
  return consumed;
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
  /** Who this account lets see its goals. */
  visibility: ProfileVisibility;
  /** True when `visibility === 'private'`, also hides the follower lists. */
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
/** The demo profiles' ids: local-only, and never governed by the shared graph. */
const FAKE_IDS = new Set(FAKE_PROFILES.map((p) => p.id));

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
    profileVisibility: 'public',
    isPrivate: false,
  };
}

function fakeTerminalGoal(
  userId: string,
  name: string,
  status: GoalStatus,
  hoursAgo: number,
  title: string,
  goalNumber: number,
): Goal {
  const at = new Date(Date.now() - hoursAgo * 3_600_000).toISOString();
  const decision: JudgeDecision | undefined =
    status === 'completed' ? 'completed' : status === 'failed_notified' ? 'not_completed' : undefined;
  return {
    id: uuid(),
    userId,
    goalNumber,
    creatorName: name,
    creatorDeviceId: 'seed-device',
    title,
    description: '',
    requiredActionsCount: 3,
    plannedActions: [],
    deadlineAt: at,
    status,
    messageTone: 'neutral',
    ackNotifyConsent: true,
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
      let n = 1;
      for (let i = 0; i < (p.completed ?? 0); i++) {
        goals.push(fakeTerminalGoal(p.id, p.name, 'completed', 24 * (i + 2), TITLES[i % TITLES.length], n++));
      }
      for (let i = 0; i < (p.failed ?? 0); i++) {
        goals.push(fakeTerminalGoal(p.id, p.name, 'failed_notified', 24 * (i + 2) + 6, TITLES[(i + 3) % TITLES.length], n++));
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
    visibility: visibilityOf(u),
    isPrivate: visibilityOf(u) === 'private',
  };
}

/** A user's goal visibility, defaulting old rows from the legacy boolean. */
function visibilityOf(u: User): ProfileVisibility {
  return u.profileVisibility ?? (u.isPrivate ? 'private' : 'public');
}

/**
 * Write a person the server told us about into the local user list.
 *
 * Everything downstream — profiles, friend lists, the judge picker, goal
 * history — reads `getUsers()`, so this is the one place a real account from
 * another phone becomes visible to all of it. Only the public half is stored:
 * a name, an avatar, a bio. There is no password, no email and no goals.
 */
function upsertRemotePerson(person: DirectoryPerson, followsMe: boolean, meId: string): void {
  const users = getUsers();
  const existing = users.find((u) => u.id === person.id);
  const following = existing?.following ?? [];
  const nextFollowing = followsMe
    ? (following.includes(meId) ? following : [...following, meId])
    : following.filter((id) => id !== meId);

  if (existing) {
    existing.name = person.name || existing.name;
    existing.avatar = person.avatar || existing.avatar;
    existing.bio = person.bio || existing.bio;
    existing.following = nextFollowing;
  } else {
    users.push({
      id: person.id,
      name: person.name || 'Someone',
      // Deliberately blank: the directory does not carry an address, and this
      // device has no business holding one for somebody else.
      email: '',
      password: '',
      accountType: 'standard',
      subscription: { status: 'none', priceUsd: SUBSCRIPTION_PRICE_MONTHLY, provider: 'placeholder' },
      plan: 'free',
      isPremium: false,
      theme: 'default',
      createdAt: new Date().toISOString(),
      bio: person.bio,
      avatar: person.avatar,
      following: nextFollowing,
      profileVisibility: 'public',
      isPrivate: false,
    });
  }
  saveUsers(users);
}

/**
 * Pull the shared graph and make this device agree with it.
 *
 * The server is the truth for who exists and who follows whom, because those
 * are the only two facts two different phones have to agree on. This account's
 * own `following` is rewritten from it rather than merged: a follow removed on
 * another device has to disappear here too, and a local list that only ever
 * grows would quietly resurrect it.
 */
export async function syncSocialGraph(currentUserId: string): Promise<void> {
  if (!socialSyncEnabled()) return;
  const people = await fetchGraph();
  const me = getUsers().find((u) => u.id === currentUserId);
  if (!me) return;

  for (const person of people) upsertRemotePerson(person, person.followsMe, currentUserId);

  // Demo profiles keep whatever the seed gave them; only real ids are governed
  // by the server, so a device with both keeps working either way.
  const remoteIds = new Set(people.map((p) => p.id));
  const iFollowRemotely = people.filter((p) => p.iFollow).map((p) => p.id);
  const keptLocal = (getUsers().find((u) => u.id === currentUserId)?.following ?? [])
    .filter((id) => !remoteIds.has(id) && FAKE_IDS.has(id));
  persistUser({ ...me, following: [...new Set([...keptLocal, ...iFollowRemotely])] });
}

/** Publish this account's public profile so other people can find it. */
export async function publishMyProfile(user: User): Promise<void> {
  if (!socialSyncEnabled() || user.isGuest) return;
  await publishProfile({ name: user.name, avatar: user.avatar ?? '', bio: user.bio ?? '' });
}

/**
 * Find real accounts by name, and remember them locally so the rest of the app
 * can show and follow them.
 */
export async function searchProfiles(currentUserId: string, query: string): Promise<SocialProfile[]> {
  if (!socialSyncEnabled()) return [];
  const found = await searchPeople(query);
  for (const person of found) {
    const followsMe = (getUsers().find((u) => u.id === person.id)?.following ?? []).includes(currentUserId);
    upsertRemotePerson(person, followsMe, currentUserId);
  }
  const users = getUsers();
  const me = users.find((u) => u.id === currentUserId);
  if (!me) return [];
  const fc = buildFollowerCounts(users);
  return found
    .map((person) => users.find((u) => u.id === person.id))
    .filter((u): u is User => !!u)
    .map((u) => toSocialProfile(u, me, fc));
}

/** Fill in the name and avatar for ids this device has but has never seen. */
export async function hydratePeople(currentUserId: string, ids: string[]): Promise<void> {
  if (!socialSyncEnabled()) return;
  const unknown = ids.filter((id) => id && !getUsers().some((u) => u.id === id));
  if (unknown.length === 0) return;
  for (const person of await fetchPeople(unknown)) {
    upsertRemotePerson(person, false, currentUserId);
  }
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
  /** completed / (completed + not-completed), as a percent, null if none resolved. */
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
  const wasFollowing = me.following.includes(targetId);
  const following = wasFollowing
    ? me.following.filter((id) => id !== targetId)
    : [...me.following, targetId];

  // A follow only means anything if the OTHER person's phone can see it, which
  // is the whole reason the graph moved to the server. A demo profile has no
  // account, so it stays local and simply never reaches one.
  if (socialSyncEnabled() && !FAKE_IDS.has(targetId)) {
    const ok = await setFollow(targetId, !wasFollowing);
    if (!ok) throw new SyncError('offline', "We couldn't reach the server. Try again in a moment.");
  }
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

/** A user's finished (terminal) goals, newest first, for their public profile. */
/* ────────────────────────────────────── Profile goals + success rate ── */

/** One tab of the profile: the goals in it and how they went. */
export interface GoalTabStats {
  goals: Goal[];
  completed: number;
  missed: number;
  /** completed / (completed + missed) as a whole percent; null with nothing decided. */
  successRate: number | null;
}

/** Why a viewer may not see someone's goals. */
export type ProfileGoalsBlock = 'private' | 'friends-only';

export interface ProfileGoalsView {
  allowed: boolean;
  blockedBy?: ProfileGoalsBlock;
  /** Goals the user set for themselves, with no judge. */
  solo: GoalTabStats;
  /** Goals a judge ruled on. */
  judged: GoalTabStats;
}

function tabStats(goals: Goal[]): GoalTabStats {
  const completed = goals.filter((g) => g.status === 'completed').length;
  const missed = goals.filter((g) => g.status === 'failed_notified').length;
  const decided = completed + missed;
  return {
    goals,
    completed,
    missed,
    successRate: decided > 0 ? Math.round((completed / decided) * 100) : null,
  };
}

const emptyTab = (): GoalTabStats => ({ goals: [], completed: 0, missed: 0, successRate: null });

/**
 * The finished goals shown on someone's profile, split into "no judge" and
 * "with a judge", each with its success rate.
 *
 * The visibility rule lives HERE rather than in the view, so no screen can leak
 * a private profile by forgetting to check: `private` → owner only, `friends` →
 * mutual follows only, `public` → anyone. Goal CONTENT is still per goal, the
 * caller renders an unpublished goal as "Goal #N" (see `goalPublicLabel`).
 */
export async function getProfileGoals(viewerId: string, targetId: string): Promise<ProfileGoalsView> {
  await delay(80);
  resolveExpired();
  const users = getUsers();
  const target = users.find((u) => u.id === targetId);
  const viewer = users.find((u) => u.id === viewerId);
  if (!target) return { allowed: false, blockedBy: 'private', solo: emptyTab(), judged: emptyTab() };

  const isOwner = viewerId === targetId;
  const visibility = visibilityOf(target);
  if (!isOwner && visibility !== 'public') {
    if (visibility === 'private') {
      return { allowed: false, blockedBy: 'private', solo: emptyTab(), judged: emptyTab() };
    }
    // 'friends': mutual follow required, in both directions.
    const friends =
      !!viewer && viewer.following.includes(targetId) && target.following.includes(viewerId);
    if (!friends) {
      return { allowed: false, blockedBy: 'friends-only', solo: emptyTab(), judged: emptyTab() };
    }
  }

  const finished = getGoals()
    .filter((g) => g.userId === targetId && TERMINAL_STATUSES.includes(g.status))
    .sort(
      (a, b) =>
        +new Date(b.failedAt ?? b.completedAt ?? b.createdAt) -
        +new Date(a.failedAt ?? a.completedAt ?? a.createdAt),
    );

  return {
    allowed: true,
    solo: tabStats(finished.filter((g) => g.noJudge)),
    judged: tabStats(finished.filter((g) => !g.noJudge)),
  };
}

/** Change who can see this account's goals. Always reversible. */
export async function setProfileVisibility(userId: string, visibility: ProfileVisibility): Promise<User> {
  await delay(60);
  const user = getUsers().find((u) => u.id === userId);
  if (!user) throw new Error('User not found.');
  logAudit({ actorId: userId, actionType: 'profile_visibility_changed', entityType: 'user', entityId: userId, metadata: { visibility } });
  return normalizeUser(persistUser({ ...user, profileVisibility: visibility, isPrivate: visibility === 'private' }));
}

/**
 * A user's FINISHED goals: what a profile shows. Running goals are deliberately
 * excluded: while a goal is live it is nobody's business but the owner's.
 */
export async function listCompletedGoals(userId: string): Promise<Goal[]> {
  await delay(80);
  resolveExpired();
  return getGoals()
    .filter((g) => g.userId === userId && TERMINAL_STATUSES.includes(g.status))
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

/* ──────────────────────────────────────────────────── Renewing goals ── */

/**
 * The private half of the app: a goal that comes back on the days you choose,
 * scored by nothing but your own record of it.
 *
 * Deliberately has no judge, no recipients and no app block. Those exist to put
 * something at stake for ONE deadline; asking a friend to rule on the same
 * commitment every morning would burn them out in a fortnight, and a habit you
 * are building is not something to punish yourself over on day three.
 */

function getRenewing(): RenewingGoal[] {
  return read<RenewingGoal[]>(KEYS.renewingGoals, []);
}

function saveRenewing(list: RenewingGoal[]): void {
  write(KEYS.renewingGoals, list);
}

/** Valid, deduplicated and in a stable order, so two equal schedules compare equal. */
function normalizeDays(days: readonly number[] | undefined): Weekday[] {
  const set = new Set<Weekday>();
  for (const d of days ?? []) {
    const n = Math.trunc(Number(d)) as Weekday;
    if (EVERYDAY.includes(n)) set.add(n);
  }
  return [...set].sort((a, b) => a - b);
}

function requireRenewingTitle(raw: string): string {
  const title = raw.trim().slice(0, 120);
  if (!title) throw new Error('Give the goal a name.');
  return title;
}

function mineOrThrow(id: string, userId: string): { list: RenewingGoal[]; goal: RenewingGoal } {
  const list = getRenewing();
  const goal = list.find((g) => g.id === id);
  if (!goal) throw new Error('That goal no longer exists.');
  if (goal.userId !== userId) throw new Error('That goal belongs to someone else.');
  return { list, goal };
}

export interface CreateRenewingGoalInput {
  userId: string;
  title: string;
  note?: string;
  /** Weekdays it is due. All seven is "every day"; at least one is required. */
  days: readonly number[];
}

export async function createRenewingGoal(input: CreateRenewingGoalInput): Promise<RenewingGoal> {
  await delay(80);
  const title = requireRenewingTitle(input.title);
  const days = normalizeDays(input.days);
  if (days.length === 0) throw new Error('Pick at least one day of the week.');

  const now = new Date().toISOString();
  const goal: RenewingGoal = {
    id: uid('renew'),
    userId: input.userId,
    title,
    note: input.note?.trim().slice(0, 500) || undefined,
    days,
    // History starts today: days before the goal existed were never missed.
    startedAt: now,
    entries: [],
    createdAt: now,
    updatedAt: now,
  };
  saveRenewing([goal, ...getRenewing()]);
  return goal;
}

export async function listRenewingGoals(userId: string): Promise<RenewingGoal[]> {
  await delay(60);
  return getRenewing()
    .filter((g) => g.userId === userId)
    // Live ones first, then by newest — an archived goal is a record, not a task.
    .sort((a, b) => {
      const archived = Number(!!a.archivedAt) - Number(!!b.archivedAt);
      return archived !== 0 ? archived : +new Date(b.createdAt) - +new Date(a.createdAt);
    });
}

export async function getRenewingGoal(id: string): Promise<RenewingGoal | null> {
  await delay(40);
  return getRenewing().find((g) => g.id === id) ?? null;
}

export async function updateRenewingGoal(
  id: string,
  userId: string,
  patch: { title?: string; note?: string; days?: readonly number[] },
): Promise<RenewingGoal> {
  await delay(60);
  const { list, goal } = mineOrThrow(id, userId);

  const next: RenewingGoal = { ...goal, updatedAt: new Date().toISOString() };
  if (patch.title !== undefined) next.title = requireRenewingTitle(patch.title);
  if (patch.note !== undefined) next.note = patch.note.trim().slice(0, 500) || undefined;
  if (patch.days !== undefined) {
    const days = normalizeDays(patch.days);
    if (days.length === 0) throw new Error('Pick at least one day of the week.');
    // Entries for days that are no longer due stay put: they record what actually
    // happened, and rewriting history to match a new schedule would be a lie.
    next.days = days;
  }

  saveRenewing(list.map((g) => (g.id === id ? next : g)));
  return next;
}

/**
 * Mark one day done or not done.
 *
 * Defaults to today, and refuses the future outright — marking tomorrow's run
 * complete is the one thing that would make the whole record worthless. Past
 * days are allowed, because people forget to open the app and the alternative is
 * a streak lost to a missed tap rather than a missed run.
 */
export async function markRenewingDay(
  id: string,
  userId: string,
  status: RenewingEntryStatus,
  date?: string,
): Promise<RenewingGoal> {
  await delay(60);
  const { list, goal } = mineOrThrow(id, userId);

  const now = new Date();
  const key = date ?? dayKey(now);
  if (key > dayKey(now)) throw new Error("You can't mark a day that hasn't happened yet.");
  if (!isDueOn(goal.days, fromDayKey(key))) {
    throw new Error("This goal isn't due on that day.");
  }
  if (key < dayKey(new Date(goal.startedAt))) {
    throw new Error('That day is before the goal started.');
  }

  const entry: RenewingEntry = { date: key, status, at: now.toISOString() };
  const next: RenewingGoal = {
    ...goal,
    entries: [...goal.entries.filter((e) => e.date !== key), entry].sort((a, b) => a.date.localeCompare(b.date)),
    updatedAt: now.toISOString(),
  };

  saveRenewing(list.map((g) => (g.id === id ? next : g)));
  return next;
}

/** Undo a mark, for the tap that went on the wrong row. */
export async function clearRenewingDay(id: string, userId: string, date: string): Promise<RenewingGoal> {
  await delay(60);
  const { list, goal } = mineOrThrow(id, userId);
  const next: RenewingGoal = {
    ...goal,
    entries: goal.entries.filter((e) => e.date !== date),
    updatedAt: new Date().toISOString(),
  };
  saveRenewing(list.map((g) => (g.id === id ? next : g)));
  return next;
}

/**
 * Retire a goal without losing what it recorded.
 *
 * Archiving rather than deleting is the default because the history IS the
 * point: someone who kept a habit for four months and stopped should still be
 * able to see those four months.
 */
export async function archiveRenewingGoal(id: string, userId: string): Promise<RenewingGoal> {
  await delay(60);
  const { list, goal } = mineOrThrow(id, userId);
  const next: RenewingGoal = { ...goal, archivedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  saveRenewing(list.map((g) => (g.id === id ? next : g)));
  return next;
}

export async function resumeRenewingGoal(id: string, userId: string): Promise<RenewingGoal> {
  await delay(60);
  const { list, goal } = mineOrThrow(id, userId);
  const now = new Date().toISOString();
  // The gap while it was archived is not counted as missed: history restarts
  // from the day it came back.
  const next: RenewingGoal = { ...goal, archivedAt: undefined, startedAt: now, updatedAt: now };
  saveRenewing(list.map((g) => (g.id === id ? next : g)));
  return next;
}

export async function deleteRenewingGoal(id: string, userId: string): Promise<void> {
  await delay(60);
  const { list } = mineOrThrow(id, userId);
  saveRenewing(list.filter((g) => g.id !== id));
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
