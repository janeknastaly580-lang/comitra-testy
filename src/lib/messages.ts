/**
 * Failure-message composition + sensitive-content validation.
 *
 * There is no money, stake or reward anywhere in this app. The only consequence
 * of a missed goal is an optional message to pre-approved recipients. This
 * module builds that message from the chosen tone and keeps it legally safe.
 *
 * PRIVACY RULE: a recipient is told only that a numbered goal was not completed.
 * The goal's title and description NEVER appear in any message, there is no
 * opt-in that changes this, not even marking the goal public afterwards (that
 * only affects the owner's profile). The same rule applies to the judge.
 */
import { goalRef } from './goal';
import type { Goal, MessageTone } from './types';

/** Fields needed to render a preview before a goal is fully built. */
export interface FailureMessageInput {
  ownerName: string;
  tone: MessageTone;
  /** The owner's per-goal number: the only detail a recipient ever gets. */
  goalNumber: number;
}

/**
 * The one sentence the chosen tone adds after the plain statement of fact. Tone
 * changes only the framing, never the safety: no insults, no moral judgement,
 * no "lazy / shame", and never any goal content.
 *
 * Kept identical to `TONE_SUFFIX` in server/src/twilio/templates.js, so the text
 * a recipient is sent matches the preview the owner approved.
 */
const TONE_SUFFIX: Record<MessageTone, string> = {
  neutral: '',
  supportive: ' You can send them a few words of encouragement to help them get back on track.',
  firm: ' They asked to have you told if they did not keep their commitment.',
};

/** Compose the failure-notification message: who, which numbered goal, tone. */
export function buildFailureMessage(input: FailureMessageInput): string {
  const name = input.ownerName.trim() || 'Someone';
  const ref = goalRef({ goalNumber: input.goalNumber });
  return `${name} failed their ${ref}.${TONE_SUFFIX[input.tone] ?? TONE_SUFFIX.neutral}`;
}

/** Build the failure message straight from a stored goal. */
export function failureMessageForGoal(goal: Goal): string {
  return buildFailureMessage({
    ownerName: goal.creatorName,
    tone: goal.messageTone,
    goalNumber: goal.goalNumber,
  });
}

/**
 * Neutral invite text sent to a recipient. It does NOT reveal the goal content,
 * only that the owner wants to be able to notify them about a goal.
 */
export function recipientInviteMessage(ownerName: string): string {
  const name = ownerName.trim() || 'An Comitra user';
  return (
    `${name} wants to add you as someone who can receive notifications about the ` +
    `result of their goal in the Comitra app. Accept if you agree to ` +
    `receive such notifications.`
  );
}

/* ─────────────────────────────────────────── Sensitive-content guard ── */

/**
 * Topics this app must not be used to disclose to other people. Detection is
 * intentionally conservative (keyword-based), it warns and blocks automatic
 * activation rather than silently allowing a sensitive goal through.
 */
const SENSITIVE_PATTERNS: { topic: string; re: RegExp }[] = [
  { topic: 'medical / health condition', re: /\b(diagnos(is|ed|e)|disease|illness|cancer|tumou?r|symptom|clinic|hospital|surgery|medical|patient)\b/i },
  { topic: 'medication', re: /\b(medication|medicine|pills?|prescription|antibiotic|insulin|dose|dosage|drug)\b/i },
  { topic: 'therapy / mental health', re: /\b(therapy|therapist|psychiatr|psycholog|depress|anxiety|trauma|counsel(l)?ing)\b/i },
  { topic: 'addiction', re: /\b(addict(ion|ed)?|alcoholi|rehab|sober(ing|iety)?|relapse|withdrawal)\b/i },
  { topic: 'sexual matters', re: /\b(sex(ual|uality)?|porn|nudes?|escort|hookup)\b/i },
  { topic: 'religion', re: /\b(religio(n|us)|church|mosque|synagogue|pray(er|ing)?|bible|quran|god|faith)\b/i },
  { topic: 'politics', re: /\b(politic(s|al)|election|vote|republican|democrat|communis|fascis|government policy)\b/i },
  { topic: 'financial situation', re: /\b(debt|loan|mortgage|salary|bankrupt|money problems|gambl)\b/i },
  { topic: 'children’s data', re: /\b(my (kid|child|son|daughter|baby)|children'?s|toddler|infant)\b/i },
  { topic: 'violence', re: /\b(kill|attack|assault|weapon|gun|knife|beat (him|her|them)|revenge|hurt someone)\b/i },
  { topic: 'self-harm', re: /\b(self.?harm|suicid|cut myself|end my life|kill myself)\b/i },
  { topic: 'eating disorder', re: /\b(anorexi|bulimi|purge|starv(e|ing)|eating disorder|not eating|stop eating|przesta(n|ń)ę? jeś[cć]|nie będę jeś[cć])\b/i },
  { topic: 'stopping medication', re: /\b(stop (taking )?(my )?(meds|medication|pills)|go off (my )?meds|odstaw(i[cć]|ię)? lek)\b/i },
  { topic: 'treating a mental-health condition', re: /\b(cure|beat|treat|fix) (my )?(depress|anxiet)|wylecz(ę|yć)? depresj/i },
];

export interface ContentCheck {
  ok: boolean;
  /** The sensitive topics detected, for display. */
  topics: string[];
}

/** Scan a goal's title + description for sensitive topics. */
export function checkGoalContent(title: string, description: string): ContentCheck {
  const text = `${title}\n${description}`;
  const topics: string[] = [];
  for (const { topic, re } of SENSITIVE_PATTERNS) {
    if (re.test(text) && !topics.includes(topic)) topics.push(topic);
  }
  return { ok: topics.length === 0, topics };
}

/** The user-facing message shown when a goal looks sensitive. */
export const SENSITIVE_CONTENT_MESSAGE =
  'This app is for reaching goals and building consistency. Don’t use it to ' +
  'disclose especially private information. Set an action-based goal, for example a ' +
  'number of completed steps, not one about health, a diagnosis or treatment.';
