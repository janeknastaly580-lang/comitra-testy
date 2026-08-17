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
import { goalRef } from './goal';
import { failureMessageForGoal, recipientInviteMessage } from './messages';
import { getDeviceId, KEYS, read, uid, uuid, write } from './storage';
import {
  CHALLENGE_MAX_POINTS,
  CHALLENGE_MAX_TEAM,
  CHALLENGE_MIN_POINTS,
  CHALLENGE_MIN_TEAM,
  declinedMembers,
  everyoneAccepted,
  outcomeOf,
} from './teamChallenge';
import {
  remoteGetGoal,
  remoteListInvitedJudges,
  remotePutGoal,
  remoteSyncHealth,
  remoteUpsertInvitedJudge,
  supabaseEnabled,
  SyncError,
  type RemoteInvitedJudge,
  type SyncErrorKind,
  type SyncHealth,
} from './supabase';
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
  Channel,
  ChallengeMember,
  ChallengeRole,
  FeatureRequest,
  FeatureRequestView,
  Goal,
  GoalEvidence,
  GoalJudge,
  GoalReflection,
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
  ProfileVisibility,
  RecipientConsent,
  Subscription,
  TeamChallenge,
  TeamChallengeMode,
  TeamSide,
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
  if (!supabaseEnabled() || goal.noJudge) return;
  const task = remotePutGoal({
    id: goal.id,
    ownerUserId: goal.userId,
    judgeToken: goal.judge.acceptToken,
    shareToken: goal.shareToken,
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
  // A judge's "not completed" can only be delivered by the owner's device: the
  // recipients' contacts live there and nowhere else.
  if (merged.status === 'failed_pending_notification') dispatchFailureNotifications(merged.id);
  return getGoals().find((g) => g.id === merged.id) ?? merged;
}

/**
 * Pull one goal from the shared store using a token from its link. Best-effort
 * by default; `strict` lets the judge view tell "no such goal" apart from "the
 * server never answered", which are very different things to show someone.
 */
async function pullGoal(id: string, token: string, strict = false): Promise<Goal | null> {
  if (!supabaseEnabled() || !id || !token) return null;
  try {
    const row = await remoteGetGoal(id, token);
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
  await Promise.all(mine.slice(0, 12).map((g) => pullGoal(g.id, g.judge.acceptToken)));
}

export async function getGoal(id: string): Promise<Goal | null> {
  resolveExpired();
  const local = getGoals().find((g) => g.id === id) ?? null;
  if (local && !local.noJudge && !TERMINAL_STATUSES.includes(local.status)) {
    await pullGoal(id, local.judge.acceptToken);
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
  /** Omit the judge entirely to create a solo (self-tracked) goal. */
  judge?: { name: string; channel: Channel; contact?: string; judgeUserId?: string };
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

/**
 * The stored form of a contact. Only email addresses reach this now — a judge's
 * address — and lower-casing is what makes "Kasia@x.com" and "kasia@x.com" the
 * same judge rather than two.
 */
function normalizeContact(_channel: Channel, raw?: string): string | undefined {
  if (!raw) return undefined;
  return raw.trim().toLowerCase();
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
  // (and set a code), the judge does not need to re-consent, pre-accept them.
  if (input.judge) {
    const standing = findJudgeCredential(input.userId, judgeKeyFor(judge));
    if (standing) {
      judge.status = 'accepted';
      judge.acceptedAt = new Date().toISOString();
      judge.codeSet = true;
      if (standing.judgeAccountUserId) judge.judgeAccountUserId = standing.judgeAccountUserId;
    }
  }

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
    evidence: [],
    judge,
    recipients: consents.map((c) => ({ consentId: c.id })),
    shareToken: judge.acceptToken,
    createdAt: new Date().toISOString(),
  };

  goals.push(recompute(goal));
  saveGoals(goals);

  // Notification #2: ask the chosen judge to accept the role (unless pre-accepted).
  // Carries the goal NUMBER only: never the title or the details.
  if (input.judge && judge.status !== 'accepted') {
    queueOutbox({
      goalId: goal.id,
      kind: 'judge_invite',
      to: 'judge',
      channel: judge.channel,
      contact: judge.judgeContact,
      body:
        `${goal.creatorName} asks you to be the judge for their ${goalRef(goal)}. Open your judge ` +
        `link to accept the role, set your secret code, and later say whether they completed it. ` +
        `Comitra does not show you what the goal is. ${goal.creatorName} tells you that themselves.`,
    });
  }

  if (recips.length > 0) {
    logLegalAcceptance({ type: 'goal_notify_ack', userId: input.userId, goalId: goal.id });
  }
  logAudit({ actorId: input.userId, actionType: 'goal_created', entityType: 'goal', entityId: goal.id, metadata: { tone: goal.messageTone, recipients: consents.length } });
  // The judge link is offered on the very next screen, so the goal has to be in
  // the shared store before the owner can send it anywhere.
  await flushGoalSync();
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
 * Add proof of completion. Links the proof to a planned step, the one given, or
 * otherwise the next open step: and advances that step's status. Updates
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

  goal.evidence = [item, ...goal.evidence];
  saveGoals(goals);
  // Comitra never messages the judge on its own, not even "there's proof now":
  // the owner sends the judge one of the two links from the goal screen when
  // they want something from them. See `applyJudgeLinkRequest`.
  logAudit({ actorId: goal.userId, actionType: 'evidence_added', entityType: 'goal', entityId: goal.id, metadata: { type: item.type } });
  return goal;
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
  // Admitting the miss costs exactly what letting the deadline pass costs: the
  // app block the user chose when they set the goal. Otherwise "I failed" would
  // be the cheap way out of the penalty.
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
 * Resolve goals whose deadline has passed.
 *
 * Solo (judge-less) goals end here: missing the deadline is the failure, and the
 * app-block penalty starts.
 *
 * A JUDGED goal does not. Nothing about a passing deadline decides it, so it
 * stays `active` until its judge says completed or not completed: it keeps
 * showing under Active goals, and stays out of the history and every
 * leaderboard, however long that takes. There is deliberately no timeout that
 * would close it without a decision.
 */
function resolveExpired() {
  ensureGoalNumbers();
  const now = Date.now();
  const goals = getGoals();
  let changed = false;
  for (const g of goals) {
    if (g.status === 'active' && now > +new Date(g.deadlineAt) && g.noJudge) {
      // Solo goal missed → apply the app-block penalty (blocks the chosen app
      // for `durationMinutes` starting now). See src/lib/appBlock.ts.
      g.status = 'failed_notified';
      g.failedAt = new Date().toISOString();
      liftCommitmentBlock(g); // the goal is over, so its commitment block ends
      applyAppBlockPenalty(g, now);
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

/**
 * Placeholder hash stored for a judge whose acceptance was synced from another
 * device. The real password hash never leaves the judge's own device, so on the
 * owner's device we only need a marker that a standing acceptance EXISTS (used by
 * `createGoal` to pre-accept). This value can never match a real code hash, which
 * is fine: the owner is device-blocked from ever verifying a code themselves.
 */
const SYNCED_CODE_SENTINEL = 'synced:remote';

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
  upsertJudgeCredentialHash(ownerUserId, judgeKey, hashCode(code), judgeAccountUserId);
}

/**
 * Same as `upsertJudgeCredential` but takes an already-hashed code. Used when a
 * standing acceptance arrives from the shared store (another device), where only
 * the hash: never the raw password: is available.
 */
function upsertJudgeCredentialHash(ownerUserId: string, judgeKey: string, codeHash: string, judgeAccountUserId?: string): void {
  if (!judgeKey || !codeHash) return;
  const list = getJudgeCredentials();
  const existing = list.find((c) => c.ownerUserId === ownerUserId && c.judgeKey === judgeKey);
  if (existing) {
    existing.codeHash = codeHash;
    if (judgeAccountUserId) existing.judgeAccountUserId = judgeAccountUserId;
  } else {
    list.push({ id: uid('jc'), ownerUserId, judgeKey, codeHash, judgeAccountUserId, createdAt: new Date().toISOString() });
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
 * opens on ANY device: this is what makes cross-device invites work without a
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

/** Why an invite can't be accepted here (so we never show a bare "invalid"). */
export type JudgeInviteBlockReason = 'unreadable' | 'same-device' | 'same-account';

/** What the public accept page can resolve from an invite token. */
export interface JudgeInviteInfo {
  /** `false` when the token is missing/corrupted/from an old version. */
  ok: boolean;
  reason?: JudgeInviteBlockReason;
  ownerName: string;
  ownerUserId: string;
  /** True when opened on the same device that generated the link (must be blocked). */
  sameDevice: boolean;
  /** True when the person opening it is logged in as the inviter (must be blocked). */
  sameAccount: boolean;
}

/**
 * Resolve an invite token for the public accept page. Never returns null now:
 * an unreadable token comes back as `{ ok:false, reason:'unreadable' }` so the
 * page can explain the problem instead of just saying "invalid".
 */
export async function getJudgeInvite(token: string): Promise<JudgeInviteInfo> {
  await delay(60);
  const sessionId = read<string | null>(KEYS.session, null);
  const deviceId = getDeviceId();

  const resolve = (ownerUserId: string, ownerName: string, inviterDeviceId?: string): JudgeInviteInfo => {
    const sameDevice = !!inviterDeviceId && deviceId === inviterDeviceId;
    const sameAccount = !!sessionId && sessionId === ownerUserId;
    return {
      ok: !sameDevice && !sameAccount,
      reason: sameDevice ? 'same-device' : sameAccount ? 'same-account' : undefined,
      ownerName,
      ownerUserId,
      sameDevice,
      sameAccount,
    };
  };

  const payload = decodeInvitePayload(token);
  if (payload) {
    // Self-contained link: valid on any device.
    const owner = getUsers().find((u) => u.id === payload.o);
    return resolve(payload.o, owner?.name ?? payload.n ?? 'A Comitra user', payload.d);
  }
  // Legacy raw token (same-browser only).
  const invite = token ? getJudgeInvites().find((i) => i.token === token) : undefined;
  if (invite) {
    const owner = getUsers().find((u) => u.id === invite.ownerUserId);
    return resolve(invite.ownerUserId, owner?.name ?? 'A Comitra user', invite.inviterDeviceId);
  }
  // Token missing / corrupted / from an old app version, explain, don't say "invalid".
  return { ok: false, reason: 'unreadable', ownerName: '', ownerUserId: '', sameDevice: false, sameAccount: false };
}

/** Resolve the inviting owner (+ device) for a token, self-contained or legacy. */
function resolveInvite(token: string): { ownerUserId: string; inviterDeviceId?: string } | null {
  const payload = decodeInvitePayload(token);
  if (payload) return { ownerUserId: payload.o, inviterDeviceId: payload.d };
  const invite = getJudgeInvites().find((i) => i.token === token);
  if (!invite) return null;
  return { ownerUserId: invite.ownerUserId, inviterDeviceId: invite.inviterDeviceId };
}

/* ────────────────────────────────── Email verification ── */

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
export async function judgeEmailVerificationAvailable(): Promise<boolean> {
  return (await emailVerificationMode()) === 'required';
}

/**
 * The friend submits the invite form: their name, email and judge password, and
 * consents to Comitra messages about this owner's goals. This registers them as
 * a pickable judge for that owner and stores their standing acceptance + password.
 * The name must be unique among this owner's judges, and the link must be opened
 * on a different device than the one that created it. `emailVerified` records
 * that they passed the code check (the UI only sets it after `verifyEmailCode`
 * succeeds).
 */
export async function submitJudgeInvite(
  token: string,
  input: { name: string; email: string; code: string; emailVerified?: boolean },
): Promise<InvitedJudge> {
  await delay();
  const invite = resolveInvite(token);
  if (!invite) throw new Error("We couldn't read this invite link. Ask your friend to send you a fresh one.");
  // Anti-cheat: the inviter must not register as their own judge from their device.
  if (invite.inviterDeviceId && getDeviceId() === invite.inviterDeviceId) {
    throw new Error('Open this invite on a different device than the one that created it.');
  }
  // Anti-cheat: the inviter must not register as their own judge from their account.
  const sessionId = read<string | null>(KEYS.session, null);
  if (sessionId && sessionId === invite.ownerUserId) {
    throw new Error('You are signed in as the person who created this invite. A judge has to be someone else.');
  }
  const email = normalizeEmail(input.email);
  if (!emailLooksValid(email)) throw new Error('Enter a valid email address.');
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
    (j) => j.ownerUserId === invite.ownerUserId && j.name.trim().toLowerCase() === nameKey && j.email !== email,
  );
  if (nameTaken) {
    throw new Error('That name is already used by one of this person’s judges. Please choose a different name.');
  }

  let record = list.find((j) => j.ownerUserId === invite.ownerUserId && j.email === email);
  if (record) {
    record.name = name;
    record.consentedAt = now;
    if (input.emailVerified) record.emailVerifiedAt = now;
  } else {
    record = {
      id: uid('ij'),
      ownerUserId: invite.ownerUserId,
      name,
      email,
      consentedAt: now,
      emailVerifiedAt: input.emailVerified ? now : undefined,
      createdAt: now,
    };
    list.push(record);
  }
  write(KEYS.invitedJudges, list);

  // Store the standing acceptance + judge password for this owner+judge.
  const codeHash = hashCode(code);
  upsertJudgeCredentialHash(invite.ownerUserId, judgeKeyFor({ judgeContact: email }), codeHash);
  logLegalAcceptance({ type: 'judge_role_ack', contact: email, meta: { ownerUserId: invite.ownerUserId, source: 'invite' } });
  logAudit({ actorContact: email, actionType: 'judge_invite_accepted', entityType: 'user', entityId: invite.ownerUserId });

  // Publish to the shared store so the inviter sees this judge on THEIR device.
  // This is the whole point of the invite: without it, the registration would
  // only ever live on the judge's phone. If Supabase is configured we require
  // the sync to succeed (and tell the judge to retry on failure); if it isn't
  // configured we keep the old same-browser-only behaviour.
  //
  // SECURITY: `codeHash` is deliberately NOT sent, the judge's password stays on
  // this device only. The owner never verifies it (they can't judge their own
  // goal), so they only need to know the judge exists (see mergeRemoteInvitedJudges).
  if (supabaseEnabled()) {
    try {
      await remoteUpsertInvitedJudge({
        id: record.id,
        owner_user_id: record.ownerUserId,
        name: record.name,
        email: record.email,
        judge_account_user_id: null,
        consented_at: record.consentedAt ?? now,
        created_at: record.createdAt,
      });
    } catch (err) {
      // `SyncError` messages are already written for the person on the invite
      // page (and deliberately carry no server internals, those go to the
      // console). Anything else gets a plain retry prompt.
      if (err instanceof SyncError) throw err;
      // `cause` keeps the original for the console/devtools; the message stays
      // the friendly one, since the judge can't act on a network stack trace.
      throw new Error(
        "You're almost set, but we couldn't reach the server to finish registering you. " +
          'Check your connection and tap “Become a judge” again.',
        { cause: err },
      );
    }
  }
  return record;
}

/**
 * Pull the judges registered for this owner from the shared store into the local
 * cache, and materialise each one's standing credential so `createGoal` can
 * pre-accept them. This is what makes a judge who signed up on another device
 * actually appear in the owner's picker.
 */
function mergeRemoteInvitedJudges(ownerUserId: string, remote: RemoteInvitedJudge[]): void {
  if (remote.length === 0) return;
  const local = getInvitedJudges();
  let changed = false;
  for (const r of remote) {
    if (r.owner_user_id !== ownerUserId) continue;
    const existing = local.find((j) => j.ownerUserId === ownerUserId && j.email === r.email);
    if (existing) {
      if (existing.name !== r.name) {
        existing.name = r.name;
        changed = true;
      }
    } else {
      local.push({
        id: r.id,
        ownerUserId,
        name: r.name,
        email: r.email,
        consentedAt: r.consented_at ?? r.created_at,
        createdAt: r.created_at,
      });
      changed = true;
    }
    // Materialise a standing acceptance so a picked judge's goal skips
    // waiting-for-judge. We only have a sentinel (never the real password hash),
    // which is all the owner needs: they can't verify a code themselves anyway.
    // Don't clobber a real local hash if one somehow already exists.
    const existingCred = findJudgeCredential(ownerUserId, judgeKeyFor({ judgeContact: r.email }));
    if (!existingCred) {
      upsertJudgeCredentialHash(
        ownerUserId,
        judgeKeyFor({ judgeContact: r.email }),
        SYNCED_CODE_SENTINEL,
        r.judge_account_user_id ?? undefined,
      );
    }
  }
  if (changed) write(KEYS.invitedJudges, local);
}

/**
 * Whether cross-device judge sync is actually live, so the Invite-friends screen
 * can say so before the owner sends a link to a friend. `off` = no shared store
 * configured (invites then only work inside this browser).
 */
export async function getJudgeSyncHealth(): Promise<SyncHealth> {
  return remoteSyncHealth();
}

/** Friends the owner invited who can be picked as a judge (synced across devices). */
export async function listInvitedJudges(ownerUserId: string): Promise<InvitedJudge[]> {
  await delay(60);
  if (supabaseEnabled()) {
    // Best-effort: remoteListInvitedJudges returns [] on any failure, so a dead
    // network just falls back to whatever is already cached locally.
    const remote = await remoteListInvitedJudges();
    mergeRemoteInvitedJudges(ownerUserId, remote);
  }
  return getInvitedJudges()
    .filter((j) => j.ownerUserId === ownerUserId)
    .sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
}

/* ───────────────────────────────────────────────── Judge acceptance ── */

export type JudgeAccess =
  | { state: 'not-found' }
  | { state: 'invalid-token' }
  /** The shared store isn't configured, so a link can only open on the owner's own device. */
  | { state: 'sync-off' }
  /** The shared store exists but couldn't be asked (offline, dead address, missing SQL). */
  | { state: 'sync-unavailable'; reason: SyncErrorKind }
  | { state: 'creator-blocked'; goal: Goal }
  | { state: 'pending-acceptance'; goal: Goal }
  | { state: 'declined'; goal: Goal }
  | { state: 'awaiting-decision'; goal: Goal }
  | { state: 'decided'; goal: Goal };

/** Resolve what the /verify (judge) panel may show for a token. */
export async function getJudgeAccess(goalId: string, token: string): Promise<JudgeAccess> {
  await delay(80);
  resolveExpired();
  // The judge is on their own phone, where this goal has never existed: fetch it
  // from the shared store with the token out of the link. Refreshed even when a
  // copy is already here, so a deadline the owner moved is the one shown.
  if (supabaseEnabled()) {
    try {
      await pullGoal(goalId, token, true);
    } catch (err) {
      const kind = err instanceof SyncError ? err.kind : 'unknown';
      // Only fatal when there's nothing local to fall back on.
      if (!getGoals().some((g) => g.id === goalId)) return { state: 'sync-unavailable', reason: kind };
    }
  }
  resolveExpired();
  const goal = getGoals().find((g) => g.id === goalId);
  if (!goal) return { state: supabaseEnabled() ? 'not-found' : 'sync-off' };
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

/** What the owner asked their judge for, carried by the link they sent. */
export type JudgeLinkRequest = 'decision' | 'edit';

/**
 * Record what the owner asked for, from the link the judge just opened.
 *
 * The link IS the request: Comitra never messages a judge by itself, so a judge
 * can only be looking at `?ask=decision` / `?ask=edit` because the owner sent
 * them that link. Opening it unlocks exactly one panel — the decision one, or
 * the change/cancel one — and nothing else. Best-effort: a link for a goal that
 * is finished (or on a device that doesn't have it) simply changes nothing.
 */
export async function applyJudgeLinkRequest(
  goalId: string,
  token: string,
  ask: JudgeLinkRequest,
): Promise<void> {
  await delay(40);
  const goals = getGoals();
  const goal = goals.find((g) => g.id === goalId);
  if (!goal) return;
  if (goal.judge.acceptToken !== token && goal.shareToken !== token) return;
  if (goal.noJudge || goal.judge.decision) return;
  if (!CANCELLABLE_STATUSES.includes(goal.status)) return;

  if (ask === 'decision' && !goal.earlyDecisionRequested) {
    goal.earlyDecisionRequested = true;
  } else if (ask === 'edit' && !goal.cancelRequested) {
    goal.cancelRequested = true;
  } else {
    return; // already recorded, don't rewrite storage on every page load
  }
  saveGoals(goals);
  logAudit({
    actorContact: goal.judge.judgeContact,
    actionType: ask === 'decision' ? 'judge_asked_to_decide' : 'judge_asked_to_change',
    entityType: 'goal',
    entityId: goal.id,
  });
  await flushGoalSync();
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
  // The owner is not in the room: wait for the acceptance to reach the store, so
  // "they accepted" is a fact on the server before this screen says so.
  await flushGoalSync();
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
  await flushGoalSync();
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
  // A decision the owner never receives is worse than no decision at all.
  await flushGoalSync();
  return getGoals().find((g) => g.id === goal.id)!;
}

/**
 * The judge cancels a goal: used only when the creator asks them to (the
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
  liftCommitmentBlock(goal); // must mutate BEFORE the save, or it is not persisted
  saveGoals(goals);
  cancelAppBlock(penaltyBlockId(goal.id)); // cancelled → no penalty
  logAudit({ actorContact: goal.judge.judgeContact, actionType: 'judge_cancelled_goal', entityType: 'goal', entityId: goal.id });
  await flushGoalSync();
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
    liftCommitmentBlock(goal); // must mutate BEFORE the save, or it is not persisted
    saveGoals(goals);
    cancelAppBlock(penaltyBlockId(goal.id)); // completed → no penalty
    logAudit({ ...actor, actionType: 'goal_completed', entityType: 'goal', entityId: goal.id });
    return;
  }
  goal.status = 'failed_pending_notification';
  goal.failedAt = at;
  liftCommitmentBlock(goal); // the goal is over either way
  // Judged goal marked not completed → apply the same app-block penalty a missed
  // solo goal gets (blocks the chosen app for `durationMinutes` starting now).
  applyAppBlockPenalty(goal);
  saveGoals(goals);
  logAudit({ ...actor, actionType: 'goal_not_completed', entityType: 'goal', entityId: goal.id });
  dispatchFailureNotifications(goal.id);
}

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
 * Start the app-block penalty for a goal that was not completed. Shared by the
 * missed-solo-goal path (`resolveExpired`) and the judge's `not_completed`
 * decision, so both behave identically. Caller persists the goal.
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

/* ──────────────────────────────── Team challenges (relay / tug of war) ── */

function getChallenges(): TeamChallenge[] {
  return read<TeamChallenge[]>(KEYS.teamChallenges, []);
}
function saveChallenges(list: TeamChallenge[]) {
  write(KEYS.teamChallenges, list);
}

/**
 * Seeded demo friends have no account to sign in with, so a challenge involving
 * them would sit in `pending_invites` forever and never move. They therefore act
 * on a timer: answer their invite, then compete. Real people always act for
 * themselves: nothing below ever touches a member without `demo: true`.
 */
const DEMO_RESPOND_MS = 5_000;
const DEMO_MOVE_MS = 20_000;
const DEMO_JUDGE_MS = 4_000;

function isDemoUser(userId: string): boolean {
  return userId.startsWith('fake_');
}

/** Stable 0-9 roll from a string, so a demo verdict never flips between reads. */
function demoRoll(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return (h >>> 0) % 10;
}

/** Demo players claim a goal every so often; their demo judge then rules on it. */
function simulateDemoPlay(c: TeamChallenge, now: number): boolean {
  let changed = false;

  const demoPlayers = c.members.filter((m) => m.demo && m.role === 'player' && m.inviteStatus === 'accepted');
  if (demoPlayers.length > 0) {
    const ids = new Set(demoPlayers.map((m) => m.id));
    const done = c.tasks.filter((t) => ids.has(t.memberId)).length;
    const expected = Math.floor((now - +new Date(c.startedAt ?? c.createdAt)) / DEMO_MOVE_MS);
    // One claim per pass, so the board animates a step at a time rather than
    // jumping when a long-idle challenge is reopened.
    if (done < expected) {
      const m = demoPlayers[done % demoPlayers.length];
      c.tasks.unshift({
        id: uid('ct'),
        memberId: m.id,
        side: m.side,
        title: c.task,
        status: 'pending',
        createdAt: new Date(now).toISOString(),
      });
      changed = true;
    }
  }

  // A demo judge decides for their own side. A claim judged by a real person
  // stays pending until that person rules on it.
  for (const t of c.tasks) {
    if (t.status !== 'pending') continue;
    const judge = c.members.find((m) => m.side === t.side && m.role === 'judge');
    if (!judge?.demo) continue;
    if (now - +new Date(t.createdAt) < DEMO_JUDGE_MS) continue;
    // ~70% approved: enough misses that a rejection is visible on the board.
    t.status = demoRoll(t.id) < 7 ? 'approved' : 'rejected';
    t.decidedAt = new Date(now).toISOString();
    t.decidedByUserId = judge.userId;
    changed = true;
  }
  return changed;
}

/**
 * Move every challenge to where the clock says it should be: demo members
 * answer, a fully accepted challenge starts, demo play advances, and a decided
 * challenge is closed out. Called before any read.
 */
function advanceChallenges(): TeamChallenge[] {
  const list = getChallenges();
  const now = Date.now();
  let changed = false;

  for (const c of list) {
    if (c.status === 'pending_invites') {
      for (const m of c.members) {
        if (m.demo && m.inviteStatus === 'pending' && now - +new Date(c.createdAt) >= DEMO_RESPOND_MS) {
          m.inviteStatus = 'accepted';
          m.respondedAt = new Date(now).toISOString();
          changed = true;
        }
      }
      const declined = declinedMembers(c);
      if (declined.length > 0) {
        c.status = 'cancelled';
        c.cancelledAt = new Date(now).toISOString();
        c.declinedByName = declined[0].name;
        changed = true;
      } else if (everyoneAccepted(c)) {
        c.status = 'active';
        c.startedAt = new Date(now).toISOString();
        changed = true;
      }
    }

    if (c.status === 'active') {
      if (simulateDemoPlay(c, now)) changed = true;
      const outcome = outcomeOf(c, now);
      if (outcome) {
        c.status = 'finished';
        c.winner = outcome;
        c.finishedAt = new Date(now).toISOString();
        changed = true;
      }
    }
  }

  if (changed) saveChallenges(list);
  return list;
}

export interface CreateTeamChallengeInput {
  creatorUserId: string;
  mode: TeamChallengeMode;
  name: string;
  /** The goal every player commits to. */
  task: string;
  teamSize: number;
  teamAName: string;
  teamBName: string;
  pointsToWin: number;
  deadlineAt: string;
  /** Team A's other players: the creator always fills the first slot. */
  teamAPlayerIds: string[];
  teamBPlayerIds: string[];
  judgeAUserId: string;
  judgeBUserId: string;
}

/**
 * Set up a challenge. Everyone invited must already be a friend (a mutual
 * follow), the two rosters must be exactly the same size, and nobody may hold
 * two seats. The creator is on team A and counts as accepted; everyone else is
 * invited and the challenge stays in `pending_invites` until they all say yes.
 */
export async function createTeamChallenge(input: CreateTeamChallengeInput): Promise<TeamChallenge> {
  await delay();
  const users = getUsers();
  const creator = users.find((u) => u.id === input.creatorUserId);
  if (!creator) throw new Error('User not found.');
  if (!hasEntitlement(normalizeUser(creator))) {
    throw new Error('A subscription is required to start a team challenge.');
  }

  const size = Math.round(input.teamSize);
  if (size < CHALLENGE_MIN_TEAM || size > CHALLENGE_MAX_TEAM) {
    throw new Error(`Teams can hold ${CHALLENGE_MIN_TEAM} to ${CHALLENGE_MAX_TEAM} players.`);
  }
  const points = Math.round(input.pointsToWin);
  if (points < CHALLENGE_MIN_POINTS || points > CHALLENGE_MAX_POINTS) {
    throw new Error(`The target must be between ${CHALLENGE_MIN_POINTS} and ${CHALLENGE_MAX_POINTS} goals.`);
  }
  if (input.task.trim().length < 3) throw new Error('Describe the goal both teams are competing on.');
  if (+new Date(input.deadlineAt) <= Date.now()) throw new Error('The end date must be in the future.');

  const teamA = input.teamAPlayerIds.filter(Boolean);
  const teamB = input.teamBPlayerIds.filter(Boolean);
  // The creator occupies one seat in team A, so they only pick size − 1 more.
  if (teamA.length !== size - 1 || teamB.length !== size) {
    throw new Error(`Both teams need exactly ${size} ${size === 1 ? 'player' : 'players'}.`);
  }
  if (!input.judgeAUserId || !input.judgeBUserId) {
    throw new Error('Each team needs its own judge.');
  }

  const everyone = [input.creatorUserId, ...teamA, ...teamB, input.judgeAUserId, input.judgeBUserId];
  if (new Set(everyone).size !== everyone.length) {
    throw new Error('Each person can only take one seat. A player can’t also be a judge.');
  }

  // Only friends (mutual follows) can be invited; the judges included.
  const friends = await listFriends(input.creatorUserId);
  const friendById = new Map(friends.map((f) => [f.id, f]));
  const invited = everyone.filter((id) => id !== input.creatorUserId);
  for (const id of invited) {
    if (!friendById.has(id)) {
      throw new Error('You can only invite people from your friends list.');
    }
  }

  const now = new Date().toISOString();
  const member = (
    userId: string,
    side: TeamSide,
    role: ChallengeRole,
  ): ChallengeMember => {
    const isCreator = userId === input.creatorUserId;
    const profile = friendById.get(userId);
    return {
      id: uid('cm'),
      userId,
      name: isCreator ? creator.name : profile?.name ?? 'Friend',
      avatar: isCreator ? creator.avatar : profile?.avatar ?? '',
      side,
      role,
      // The creator accepts by creating it; everyone else has to press accept.
      inviteStatus: isCreator ? 'accepted' : 'pending',
      respondedAt: isCreator ? now : undefined,
      isCreator: isCreator || undefined,
      demo: isDemoUser(userId) || undefined,
    };
  };

  const challenge: TeamChallenge = {
    id: uid('tc'),
    createdByUserId: input.creatorUserId,
    mode: input.mode,
    name: input.name.trim() || 'Team challenge',
    task: input.task.trim(),
    teamSize: size,
    teamAName: input.teamAName.trim() || 'Team A',
    teamBName: input.teamBName.trim() || 'Team B',
    pointsToWin: points,
    deadlineAt: new Date(input.deadlineAt).toISOString(),
    status: 'pending_invites',
    members: [
      member(input.creatorUserId, 'A', 'player'),
      ...teamA.map((id) => member(id, 'A', 'player')),
      ...teamB.map((id) => member(id, 'B', 'player')),
      member(input.judgeAUserId, 'A', 'judge'),
      member(input.judgeBUserId, 'B', 'judge'),
    ],
    tasks: [],
    createdAt: now,
  };

  const list = getChallenges();
  list.unshift(challenge);
  saveChallenges(list);
  logAudit({
    actorId: input.creatorUserId,
    actionType: 'team_challenge_created',
    entityType: 'team_challenge',
    entityId: challenge.id,
    metadata: { mode: challenge.mode, teamSize: size },
  });
  return challenge;
}

/** Every challenge the user takes part in, newest first. */
export async function listTeamChallenges(userId: string): Promise<TeamChallenge[]> {
  await delay(80);
  return advanceChallenges()
    .filter((c) => c.members.some((m) => m.userId === userId))
    .sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
}

export async function getTeamChallenge(id: string): Promise<TeamChallenge | null> {
  await delay(60);
  return advanceChallenges().find((c) => c.id === id) ?? null;
}

/**
 * Accept or turn down a challenge invite. One decline ends the challenge for
 * everyone: sides have to stay equal, so a missing player can't be replaced
 * mid-invite.
 */
export async function respondToChallengeInvite(
  challengeId: string,
  userId: string,
  accept: boolean,
): Promise<TeamChallenge> {
  await delay(80);
  const list = advanceChallenges();
  const c = list.find((x) => x.id === challengeId);
  if (!c) throw new Error('Challenge not found.');
  if (c.status !== 'pending_invites') throw new Error('This challenge is no longer waiting for answers.');
  const me = c.members.find((m) => m.userId === userId);
  if (!me) throw new Error('You were not invited to this challenge.');
  if (me.inviteStatus !== 'pending') throw new Error('You have already answered this invite.');

  const now = new Date().toISOString();
  me.inviteStatus = accept ? 'accepted' : 'declined';
  me.respondedAt = now;

  if (!accept) {
    c.status = 'cancelled';
    c.cancelledAt = now;
    c.declinedByName = me.name;
  } else if (everyoneAccepted(c)) {
    c.status = 'active';
    c.startedAt = now;
  }
  saveChallenges(list);
  return c;
}

/**
 * A player says they did the goal. It counts for nothing until that team's own
 * judge rules on it, and only one claim can be open at a time per player.
 */
export async function submitChallengeTask(
  challengeId: string,
  userId: string,
  note?: string,
): Promise<TeamChallenge> {
  await delay(80);
  const list = advanceChallenges();
  const c = list.find((x) => x.id === challengeId);
  if (!c) throw new Error('Challenge not found.');
  if (c.status !== 'active') throw new Error('This challenge is not running.');
  const me = c.members.find((m) => m.userId === userId && m.role === 'player');
  if (!me) throw new Error('Only players on a team can submit a goal.');
  if (c.tasks.some((t) => t.memberId === me.id && t.status === 'pending')) {
    throw new Error('Your judge still has to decide your last one.');
  }
  c.tasks.unshift({
    id: uid('ct'),
    memberId: me.id,
    side: me.side,
    title: c.task,
    note: note?.trim() || undefined,
    status: 'pending',
    createdAt: new Date().toISOString(),
  });
  saveChallenges(list);
  return c;
}

/**
 * The judge of one team rules on a claim from their own side. Judges cannot
 * touch the other team's claims: that's the whole point of having two.
 */
export async function decideChallengeTask(
  challengeId: string,
  taskId: string,
  judgeUserId: string,
  decision: 'approved' | 'rejected',
  judgeNote?: string,
): Promise<TeamChallenge> {
  await delay(80);
  const list = advanceChallenges();
  const c = list.find((x) => x.id === challengeId);
  if (!c) throw new Error('Challenge not found.');
  if (c.status !== 'active') throw new Error('This challenge is not running.');
  const task = c.tasks.find((t) => t.id === taskId);
  if (!task) throw new Error('That goal is not in this challenge.');
  if (task.status !== 'pending') throw new Error('That goal has already been decided.');
  const judge = c.members.find((m) => m.userId === judgeUserId && m.role === 'judge');
  if (!judge) throw new Error('Only a judge can decide a goal.');
  if (judge.side !== task.side) throw new Error('You only judge your own team.');

  const now = new Date().toISOString();
  task.status = decision;
  task.decidedAt = now;
  task.decidedByUserId = judgeUserId;
  task.judgeNote = judgeNote?.trim() || undefined;

  const outcome = outcomeOf(c, Date.now());
  if (outcome) {
    c.status = 'finished';
    c.winner = outcome;
    c.finishedAt = now;
  }
  saveChallenges(list);
  return c;
}

/** The creator calls it off while people are still being invited. */
export async function cancelTeamChallenge(challengeId: string, userId: string): Promise<TeamChallenge> {
  await delay(60);
  const list = advanceChallenges();
  const c = list.find((x) => x.id === challengeId);
  if (!c) throw new Error('Challenge not found.');
  if (c.createdByUserId !== userId) throw new Error('Only the person who set it up can call it off.');
  if (c.status !== 'pending_invites') {
    throw new Error('A running challenge runs to its deadline.');
  }
  c.status = 'cancelled';
  c.cancelledAt = new Date().toISOString();
  saveChallenges(list);
  return c;
}

/** Remove a finished or cancelled challenge from the user's list. */
export async function deleteTeamChallenge(challengeId: string, userId: string): Promise<void> {
  await delay(60);
  const list = getChallenges();
  const c = list.find((x) => x.id === challengeId);
  if (!c) return;
  if (c.createdByUserId !== userId) throw new Error('Only the person who set it up can remove it.');
  if (c.status === 'active' || c.status === 'pending_invites') {
    throw new Error('You can only remove a challenge once it is over.');
  }
  saveChallenges(list.filter((x) => x.id !== challengeId));
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
