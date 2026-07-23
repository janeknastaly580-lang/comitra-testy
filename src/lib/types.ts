export type ThemeId =
  | 'default'
  | 'cyberpunk-mint'
  | 'monochrome-slate'
  | 'midnight-indigo'
  | 'solar-flare'
  | 'crimson-ember'
  | 'arctic-frost'
  | 'royal-gold'
  | 'forest-moss'
  | 'deep-ocean';

/**
 * Goal lifecycle for the social-commitment model. There is NO money, deposit,
 * pot, token or reward at any stage — the only consequence of a missed goal is
 * that pre-approved recipients may receive a message.
 */
export type GoalStatus =
  | 'draft'
  | 'waiting_for_judge_acceptance'
  | 'waiting_for_recipients_acceptance'
  | 'active'
  | 'proof_pending'
  | 'judge_review'
  | 'completed'
  | 'failed_pending_notification'
  | 'failed_notified'
  | 'cancelled'
  | 'expired_without_judge_decision'
  | 'disputed';

/** Tone of the message a recipient may receive if a goal is not completed. */
export type MessageTone = 'neutral' | 'supportive' | 'firm';

/**
 * Subscription tier. The product is a paid subscription: a free trial, then
 * $4.99/mo. There are no deposits, stakes or rewards — the fee only unlocks the
 * ability to create and run goals.
 *
 * `plan` / `isPremium` on the user are DEPRECATED and derived from the
 * subscription entitlement for backward compatibility with existing extras.
 */
export type PlanId = 'free' | 'plus' | 'premium';

/** Status of a single planned step toward a goal. */
export type PlannedActionStatus =
  | 'planned'
  | 'rescheduled'
  | 'completed'
  | 'skipped'
  | 'evidence_added'
  | 'pending_judge';

/**
 * A planned action — one step toward completing the goal. Embedded on the goal.
 */
export interface PlannedAction {
  id: string;
  /** ISO date (day) this action is planned for; optional for unscheduled slots. */
  plannedDate?: string;
  /** Free-form time hint, e.g. "18:00". */
  plannedTime?: string;
  actionType: 'step';
  /** e.g. "Step 1 — prepare materials". */
  actionName: string;
  status: PlannedActionStatus;
  /** Evidence attached to this action, if any. */
  evidenceId?: string;
  /** Original planned date, when this action has been rescheduled. */
  rescheduledFrom?: string;
  createdAt: string;
  updatedAt: string;
}

/** How a judge or recipient is reached. Limited to channels the app supports. */
export type Channel = 'email' | 'phone' | 'internal';

/* ─────────────────────────────────────────────────────────── Evidence ── */

export type EvidenceType = 'text' | 'photo' | 'link';

export interface GoalEvidence {
  id: string;
  type: EvidenceType;
  /** Text body, a data-URL for a photo, or a URL string for a link. */
  content: string;
  addedAt: string;

  /** Links this evidence to a specific planned step. */
  plannedActionId?: string;
  /** Free-form note. */
  note?: string;
  /** ISO date the action took place. */
  actionDate?: string;

  /** Convenience mirrors of `content` when a photo/link is attached. */
  photoUrl?: string;
  linkUrl?: string;
}

/* ─────────────────────────────────────────────────────────────── Judge ── */

export type JudgeStatus = 'pending' | 'accepted' | 'declined';
export type JudgeDecision = 'completed' | 'not_completed' | 'needs_proof';

/** The single judge assigned to a goal, plus their acceptance + decision. */
export interface GoalJudge {
  name: string;
  channel: Channel;
  /** Free-form contact (email / phone) or an internal user id. */
  judgeContact?: string;
  judgeUserId?: string;
  /**
   * The logged-in account (if any) that accepted this judge role. Captured when
   * the judge opens the invite link while signed in. Only judges with an account
   * accumulate a judge rating.
   */
  judgeAccountUserId?: string;
  status: JudgeStatus;
  /** Whether the judge has set their secret verification code for this role. */
  codeSet?: boolean;
  /** Token used to build the judge accept/decision link. */
  acceptToken: string;
  acceptedAt?: string;
  declinedAt?: string;
  decision?: JudgeDecision;
  decisionAt?: string;
  decisionComment?: string;
  /** Evidence that was visible to the judge at decision time (audit trail). */
  decisionEvidence?: GoalEvidence[];
  /** The 0–5 rating the goal owner gave this judge after the decision. */
  judgeRating?: number;
}

/**
 * A judge's standing acceptance + secret code for one goal-owner. Once a judge
 * accepts a role for an owner and sets a code, that acceptance persists: the
 * SAME owner can assign them again without re-asking for consent. A DIFFERENT
 * owner still needs a fresh acceptance. The judge must enter their code to
 * verify every goal.
 */
export interface JudgeCredential {
  id: string;
  /** The owner (goal creator) this credential is scoped to. */
  ownerUserId: string;
  /** Stable identity of the judge for this owner (contact or account id). */
  judgeKey: string;
  /** Hashed secret code (never stored in the clear). */
  codeHash: string;
  /** The judge's account id, if they were signed in when they accepted. */
  judgeAccountUserId?: string;
  createdAt: string;
}

/**
 * A friend the user invited (via their reusable invite link) to be a possible
 * judge. The friend submitted their phone, set their secret code (stored as a
 * `JudgeCredential`), and agreed to receive Comitra messages about this owner's
 * goals. These are the only phone numbers the owner can pick as a judge.
 */
export interface InvitedJudge {
  id: string;
  ownerUserId: string;
  name: string;
  /** Normalized phone (with country code). */
  phone: string;
  /** They agreed to receive goal-related messages from Comitra. */
  consentedAt: string;
  createdAt: string;
}

/** A reusable invite token that maps a link back to the inviting owner. */
export interface JudgeInvite {
  ownerUserId: string;
  token: string;
  /** Device the invite was generated on — the judge must accept from a different one. */
  inviterDeviceId?: string;
  createdAt: string;
}

/** One 0–5 rating of an account-holding judge, left by a goal owner. */
export interface JudgeRating {
  id: string;
  /** The account being rated (only account-holding judges are rated). */
  judgeUserId: string;
  raterUserId: string;
  goalId: string;
  /** 0–5, at most two decimals. */
  value: number;
  createdAt: string;
}

/* ───────────────────────────────────────────────────────── Recipients ── */

export type ConsentStatus = 'pending' | 'accepted' | 'revoked';

/**
 * A standing consent from one recipient to one owner. Consent persists across
 * that owner's future goals until the recipient revokes it. Stored globally,
 * keyed by (ownerUserId + contact/recipientUserId).
 */
export interface RecipientConsent {
  id: string;
  ownerUserId: string;
  /** Display name shown to the owner. */
  name: string;
  channel: Channel;
  recipientContact?: string;
  recipientUserId?: string;
  consentStatus: ConsentStatus;
  acceptedAt?: string;
  revokedAt?: string;
  /** Token used to build the recipient invite / manage / unsubscribe link. */
  inviteToken: string;
  lastNotifiedAt?: string;
  createdAt: string;
}

/** A recipient attached to a goal, referencing a standing consent. */
export interface GoalRecipient {
  consentId: string;
  /** Per-goal delivery record (set when the failure message is dispatched). */
  notifiedAt?: string;
  suppressed?: boolean;
  suppressReason?: string;
}

/** The app-block penalty attached to a solo goal. */
export interface AppBlockPenalty {
  /** Android package name of the app to block. */
  packageName: string;
  appLabel: string;
  durationMinutes: number;
}

/* ─────────────────────────────────────────────────────────────── Goal ── */

export interface Goal {
  id: string;
  userId: string;
  title: string;
  description: string;

  /** Total steps/actions that must be done to complete the goal. */
  requiredActionsCount: number;
  /** Planned steps toward the goal. */
  plannedActions: PlannedAction[];

  /** ISO date-time the goal period starts. */
  startsAt?: string;
  /** ISO date-time the goal is due (the goal's end / term). */
  deadlineAt: string;
  status: GoalStatus;

  /** Tone of the failure message the user previews and approves up front. */
  messageTone: MessageTone;
  /** Off by default — only include the goal title in the failure message if set. */
  includeGoalTitleInFailureMessage: boolean;
  /** Off by default — only include the description if the user opts in. */
  includeGoalDescriptionInFailureMessage: boolean;

  evidence: GoalEvidence[];
  judge: GoalJudge;
  recipients: GoalRecipient[];

  /** Legal acknowledgement: recipients may be messaged on failure. */
  ackNotifyConsent: boolean;
  /** Legal acknowledgement recorded when full goal content is revealed. */
  ackRevealFullContent?: boolean;
  /** Acknowledgement that the judge will see the goal's title + details. */
  ackJudgeSeesContent?: boolean;

  /** When true the goal has no judge — the creator tracks + completes it alone. */
  noJudge?: boolean;
  /** Solo-goal penalty: block a chosen app for a while if the goal is missed. */
  appBlock?: AppBlockPenalty;
  /** ISO time the app block is active until (set when the penalty triggers). */
  appBlockUntil?: string;
  /** The creator asked the judge to decide before the deadline. */
  earlyDecisionRequested?: boolean;
  /** The creator asked the judge to cancel the goal (required before the judge can). */
  cancelRequested?: boolean;
  /** Set once the judge has been auto-notified to review (avoids duplicates). */
  judgeReviewNotifiedAt?: string;

  /** Token used to build the judge link (kept name for share-link compat). */
  shareToken: string;
  /** Device id of the creator, captured at creation (device-isolation check). */
  creatorDeviceId: string;
  creatorName: string;
  creatorAvatar?: string;

  createdAt: string;
  activatedAt?: string;
  completedAt?: string;
  failedAt?: string;
  cancelledAt?: string;

  // ── DEPRECATED (money model, no longer used; kept so old records still load) ──
  /** @deprecated use deadlineAt */
  deadline?: string;
  /** @deprecated no money in this app */
  deposit?: number;
  /** @deprecated */
  isPrivate?: boolean;
}

/* ───────────────────────────────────────────────── Subscription / trial ── */

export type SubscriptionStatus = 'trialing' | 'active' | 'expired' | 'cancelled' | 'none';

/** Payment integration placeholder — swap `provider` for a real backend later. */
export type PaymentProvider =
  | 'placeholder'
  | 'stripe'
  | 'revenuecat'
  | 'appstore'
  | 'googleplay';

export interface Subscription {
  status: SubscriptionStatus;
  /** Monthly price in USD (4.99). */
  priceUsd: number;
  provider: PaymentProvider;
  trialStartedAt?: string;
  trialEndsAt?: string;
  startedAt?: string;
  currentPeriodEnd?: string;
  cancelledAt?: string;
}

/* ─────────────────────────────────────────────────────────────── User ── */

/** Account type. `trainer` unlocks the coach panel and being a client's judge. */
export type AccountType = 'standard' | 'trainer';

export interface User {
  id: string;
  name: string;
  email: string;
  password: string; // plain text — MVP / mock only

  /** Account type — standard user or personal trainer. */
  accountType: AccountType;

  /** Subscription entitlement (trial → paid). Source of truth for gating. */
  subscription: Subscription;
  /** @deprecated derived from `subscription`; retained for legacy extras. */
  plan: PlanId;
  /** @deprecated derived from `subscription`. */
  isPremium: boolean;

  theme: ThemeId;
  createdAt: string;
  /** Soft-deleted: cannot log in, but its email/name can be reused. */
  deleted?: boolean;
  /** Anonymous try-before-signup account. */
  isGuest?: boolean;

  // ── Social ─────────────────────────────────────────────────────────────
  bio: string;
  avatar: string;
  following: string[];
  isPrivate: boolean;

  // ── DEPRECATED money fields (kept so old accounts still load) ────────────
  /** @deprecated no wallet in this app */
  walletBalance?: number;
  /** @deprecated */
  transactions?: unknown[];
  /** @deprecated */
  emergencyPasses?: number;
  /** @deprecated */
  passesResetAt?: string;
  /** @deprecated */
  frozen?: boolean;
}

/* ─────────────────────────────────────────────── Notifications / logs ── */

export type NotificationStatus = 'sent' | 'suppressed';

export interface NotificationLog {
  id: string;
  goalId: string;
  ownerUserId: string;
  recipientConsentId: string;
  channel: Channel;
  tone: MessageTone;
  status: NotificationStatus;
  /** Why the message was suppressed (e.g. 'consent_revoked', 'not_accepted'). */
  reason?: string;
  /** The message body that was (or would have been) delivered. */
  body: string;
  createdAt: string;
}

/**
 * A message the system intends to deliver (the "notification system"). On the
 * MVP these are recorded here and shown in-app / shared via link; a real backend
 * would deliver them by push/SMS/email. Recipients must have consented before a
 * `recipient_message` is ever queued for them.
 */
export type OutboxKind =
  | 'recipient_consent_request'
  | 'judge_invite'
  | 'judge_review_request'
  | 'recipient_message';

export interface OutboxMessage {
  id: string;
  goalId?: string;
  kind: OutboxKind;
  to: 'recipient' | 'judge';
  channel: Channel;
  contact?: string;
  body: string;
  status: 'queued' | 'sent';
  createdAt: string;
}

/** Notification preferences per recipient consent (currently just goal results). */
export interface NotificationPreference {
  consentId: string;
  goalResults: boolean;
  marketing: boolean; // always false — never used for marketing
}

export type LegalAcceptanceType =
  | 'goal_notify_ack'
  | 'goal_reveal_full_content_ack'
  | 'judge_role_ack'
  | 'recipient_consent'
  | 'terms';

export interface LegalAcceptance {
  id: string;
  type: LegalAcceptanceType;
  userId?: string;
  contact?: string;
  goalId?: string;
  acceptedAt: string;
  meta?: Record<string, unknown>;
}

export interface AuditLog {
  id: string;
  actorId?: string;
  actorContact?: string;
  actionType: string;
  entityType: string;
  entityId: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

/* ─────────────────────────────────────────────── Trainer ↔ client ── */

export type TrainerClientStatus = 'pending' | 'accepted' | 'declined' | 'revoked';

/** A trainer↔client link. Created by a trainer's invite, accepted by the client. */
export interface TrainerClient {
  id: string;
  trainerUserId: string;
  clientUserId?: string;
  /** Display name captured from the client on acceptance (for the coach list). */
  clientName?: string;
  status: TrainerClientStatus;
  invitedBy: 'trainer' | 'client';
  inviteToken: string;
  acceptedAt?: string;
  revokedAt?: string;
  createdAt: string;
}

export interface AbuseReport {
  id: string;
  reporterRole: 'recipient' | 'judge';
  reporterContact?: string;
  ownerUserId?: string;
  goalId?: string;
  consentId?: string;
  reason: string;
  createdAt: string;
}

/* ──────────────────────────────────────────── Team challenges (2v2…8v8) ── */

/**
 * The two competition formats. Kept deliberately small — these are the only two
 * the product ships.
 *
 *  • `relay`      — two parallel tracks; every approved goal moves that team's
 *                   runner forward. A rejected goal is a stumble (no progress).
 *  • `tug_of_war` — one rope, one marker. An approved goal pulls the marker
 *                   toward the scoring team, a rejected one pulls it away.
 */
export type TeamChallengeMode = 'relay' | 'tug_of_war';

export type TeamSide = 'A' | 'B';

/** A member is either a competitor or the single judge assigned to one team. */
export type ChallengeRole = 'player' | 'judge';

export type ChallengeInviteStatus = 'pending' | 'accepted' | 'declined';

/**
 * `pending_invites` → every invited player AND both judges must accept before
 * the challenge can start. One decline kills it (`cancelled`).
 */
export type TeamChallengeStatus = 'pending_invites' | 'active' | 'finished' | 'cancelled';

export type ChallengeTaskStatus = 'pending' | 'approved' | 'rejected';

/** One person in a challenge: which side they're on and whether they accepted. */
export interface ChallengeMember {
  id: string;
  userId: string;
  name: string;
  avatar: string;
  side: TeamSide;
  role: ChallengeRole;
  inviteStatus: ChallengeInviteStatus;
  respondedAt?: string;
  /** The creator, who accepts implicitly by setting the challenge up. */
  isCreator?: boolean;
  /**
   * A seeded demo profile. They have no real account to log in with, so they
   * respond and compete on a timer — otherwise a challenge involving them could
   * never leave `pending_invites`. Real people always act for themselves.
   */
  demo?: boolean;
}

/** A player's claim that they did the challenge goal, ruled on by their judge. */
export interface ChallengeTask {
  id: string;
  memberId: string;
  side: TeamSide;
  /** What was claimed — normally the challenge goal, restated per attempt. */
  title: string;
  note?: string;
  status: ChallengeTaskStatus;
  createdAt: string;
  decidedAt?: string;
  decidedByUserId?: string;
  judgeNote?: string;
}

/** A head-to-head, goal-driven competition between two equally sized teams. */
export interface TeamChallenge {
  id: string;
  createdByUserId: string;
  mode: TeamChallengeMode;
  name: string;
  /** The goal every player on both sides commits to. */
  task: string;
  /** Players per side — identical for both teams by construction (1…8). */
  teamSize: number;
  teamAName: string;
  teamBName: string;
  /** Approved goals a side needs to win (relay laps / rope length). */
  pointsToWin: number;
  deadlineAt: string;
  status: TeamChallengeStatus;
  members: ChallengeMember[];
  tasks: ChallengeTask[];
  winner?: TeamSide | 'draw';
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  cancelledAt?: string;
  /** Set when a challenge died because someone turned the invite down. */
  declinedByName?: string;
}

/* ─────────────────────────────────────────────── Misc (unchanged) ── */

export interface TeamMember {
  name: string;
  points: number;
}

export interface Team {
  id: string;
  name: string;
  members: TeamMember[];
}

export interface League {
  id: string;
  ownerId: string;
  name: string;
  teamA: Team;
  teamB: Team;
  createdAt: string;
}

export interface FeatureRequest {
  id: string;
  title: string;
  description: string;
  authorId: string;
  authorName: string;
  createdAt: string;
  votes: Record<string, 1 | -1>;
}

export interface FeatureRequestView extends FeatureRequest {
  score: number;
  upCount: number;
  downCount: number;
  myVote: 0 | 1 | -1;
}

export interface TesterApplication {
  id: string;
  email: string;
  reason: string;
  name?: string;
  userId?: string;
  createdAt: string;
}
