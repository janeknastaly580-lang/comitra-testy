import type { MessageTone, ThemeId } from './types';

/* ─────────────────────────────────────────────── Subscription / trial ── */

/** The single subscription price. No deposits, stakes, pots or rewards exist. */
export const SUBSCRIPTION_PRICE_MONTHLY = 4.99;
/** Free trial length before a subscription is required to create new goals. */
export const TRIAL_DAYS = 7;
export const TRIAL_MS = TRIAL_DAYS * 24 * 60 * 60 * 1000;

/* ───────────────────────────────────────────────────────── Recipients ── */

/** A goal may notify at most this many recipients — never a mass broadcast. */
export const MAX_RECIPIENTS_PER_GOAL = 3;
/** Anti-spam: max new recipient invites a user may send per day. */
export const MAX_INVITES_PER_DAY = 10;

/* ─────────────────────────────────────────────────────────────── Admin ── */

export const ADMIN_EMAILS = ['janeknastaly580@gmail.com'];
export function isAdminEmail(email?: string | null): boolean {
  return !!email && ADMIN_EMAILS.includes(email.trim().toLowerCase());
}

/* ────────────────────────────────────────────────────── Templates ── */

export interface GoalTemplate {
  id: string;
  title: string;
  /** Length of the goal period, in days (used to preset the deadline). */
  periodDays: number;
  requiredActionsCount: number;
}

export const PERIOD_CHOICES: { label: string; days: number }[] = [
  { label: '1 week', days: 7 },
  { label: '2 weeks', days: 14 },
  { label: '4 weeks', days: 28 },
  { label: '30 days', days: 30 },
];

/** A few starter templates — small, realistic goals to pick from. */
export const GOAL_TEMPLATES: GoalTemplate[] = [
  { id: 'g-study5', title: 'Study 5 times this week', periodDays: 7, requiredActionsCount: 5 },
  { id: 'g-project', title: 'Finish the project by Friday', periodDays: 5, requiredActionsCount: 3 },
  { id: 'g-30min', title: 'Work on a task 30 min a day', periodDays: 7, requiredActionsCount: 7 },
  { id: 'g-read', title: 'Read 4 times in 2 weeks', periodDays: 14, requiredActionsCount: 4 },
  { id: 'g-habit', title: 'Stick to a habit for 10 days', periodDays: 10, requiredActionsCount: 10 },
  { id: 'g-declutter', title: 'Declutter 3 rooms this week', periodDays: 7, requiredActionsCount: 3 },
];

/* ──────────────────────────────────────────── Pickable goal library ── */

/**
 * Difficulty buckets. When the user chooses to let a recipient see the goal, the
 * goal MUST be picked from this library (they cannot type their own), so nothing
 * tied to sensitive personal data (health, medical, mental-health, addiction,
 * religion, politics, finances-in-trouble, etc.) can be shared with other people.
 *
 * `{n}` is a numeric slot the user fills with their own number (digits only).
 */
export type GoalDifficulty = 'easy' | 'medium' | 'hard';

export const GOAL_DIFFICULTIES: { id: GoalDifficulty; label: string }[] = [
  { id: 'easy', label: 'Easy' },
  { id: 'medium', label: 'Medium' },
  { id: 'hard', label: 'Hard' },
];

export const GOAL_LIBRARY: Record<GoalDifficulty, string[]> = {
  easy: [
    "Drink {n} glasses of water today", "Make your bed as soon as you wake up", "Read {n} pages of a book before bed", "Write {n} sentences in a journal", "Tidy one drawer in your room", "Walk for {n} minutes outside", "Do {n} minutes of stretching", "Wash the dishes right after a meal", "Water your houseplants", "Reply to {n} messages you've been putting off",
    "Clear {n} emails from your inbox", "Write down {n} things you're grateful for", "Make a to-do list for tomorrow", "Put {n} items of clothing back in the closet", "Wipe down the kitchen counter", "Take out the trash and recycling", "Learn {n} new words in a language", "Do {n} minutes of tidying before bed", "Take a {n}-minute screen-free break", "Step outside for {n} minutes of fresh air",
    "Write a short thank-you note to someone", "Plan your outfit for tomorrow", "Sort today's mail into keep and recycle", "Charge and organize your desk cables", "Delete {n} unused apps from your phone", "Unsubscribe from {n} junk email lists", "Do {n} push-ups", "Do {n} squats", "Stretch your back for {n} minutes", "Refill your water bottle {n} times today",
    "Read one news article and summarize it in a sentence", "Text a friend just to say hi", "Compliment {n} people today", "Put your phone away {n} minutes before sleep", "Make yourself a proper breakfast", "Wipe down the bathroom sink", "Fold {n} pieces of laundry", "Sweep one room", "Write {n} bullet points of ideas for a project", "Practice an instrument for {n} minutes",
    "Sketch something for {n} minutes", "Do a {n}-minute tidy of your desk", "Back up the photos on your phone", "Close your browser tabs down to {n}", "Review your calendar for the week", "Set {n} reminders for important tasks", "Read {n} pages of a work or study document", "Learn one keyboard shortcut and use it", "Take the stairs instead of the lift today", "Prepare your bag for tomorrow",
    "Write a single paragraph about your day", "Organize the files on your desktop", "Do {n} minutes of deep breathing", "Tidy the photos in one phone album", "Clean out your wallet or bag", "Water and check on a garden plant", "Read a poem out loud", "Do {n} minutes of decluttering", "Put {n} things you don't need into a donate box", "Wipe your phone screen and case",
    "Make a simple homemade snack", "Prepare tomorrow's lunch tonight", "Send a photo to a family member", "Write down {n} goals for the week", "Do {n} minutes of light exercise", "Take a short walk after lunch", "Read {n} pages about a topic you enjoy", "Learn to say hello in a new language", "Tidy your nightstand", "Set your alarm and lay out clothes for the morning",
    "Do {n} calf raises", "Practice typing for {n} minutes", "Write a quick review of something you used", "Clear {n} items off the floor of your room", "Dust one shelf", "Reply thoughtfully to {n} messages in a group chat", "Do {n} deep stretches when you wake up", "Plan one meal for tomorrow", "Organize your sock drawer", "Take a {n}-minute stroll around the block",
    "Note {n} ideas in a notebook", "Wipe down your keyboard and mouse", "Read the first {n} pages of a new book", "Practice a song for {n} minutes", "Write {n} lines of a story", "Tidy the entryway or hallway", "Put away {n} dishes from the rack", "Set a {n}-minute focus timer and work", "Take a photo of something you find beautiful", "Do {n} lunges",
    "Send an encouraging message to a friend", "Read {n} pages before checking your phone in the morning", "Empty one bin and replace the liner", "Write tomorrow's top {n} priorities", "Do a quick {n}-minute room reset", "Learn {n} facts about a country", "Sort {n} old photos into folders", "Take a break and drink a glass of water", "Do {n} jumping jacks", "Wipe down the fridge door",
    "Read a chapter summary of a book", "Practice mental math for {n} minutes", "Tidy your browser bookmarks", "Put {n} items back where they belong", "Write a short list of things that went well today", "Do {n} minutes of gentle stretching before bed", "Prepare your coffee or tea setup for the morning", "Sort the cutlery drawer", "Read {n} pages of a magazine", "Take {n} minutes to plan your evening",
    "Do {n} wall push-ups", "Clean one window", "Reply to a message from a family member", "Learn one new word and use it in a sentence", "Tidy {n} items on your desk", "Take a short walk to clear your head", "Write {n} sentences about a goal you have", "Organize your phone's home screen", "Do {n} minutes of light tidying in the kitchen", "Rinse and clean the kettle",
    "Read {n} pages while standing and stretching", "Note down {n} tasks you finished today", "Hold a plank for {n} seconds", "Wipe the dining table after a meal", "Send a good-morning message to someone", "Learn to count to {n} in a new language", "Tidy the shoes by the door", "Take {n} photos of your progress on something", "Do {n} minutes of doodling to relax", "Prepare {n} items for tomorrow's tasks",
    "Clear {n} notifications you've been ignoring", "Read one short article start to finish", "Do {n} arm circles to loosen up", "Straighten the books on a shelf", "Write a one-line summary of what you learned today", "Fill your water bottle before you start work", "Take a {n}-minute walk before dinner", "Sort {n} emails into folders", "Practice a skill for {n} minutes", "Tidy the cables behind your desk",
    "Read {n} pages and note one takeaway", "Do {n} shoulder rolls", "Send a message to reconnect with an old friend", "Plan {n} small tasks for the morning", "Wipe down the light switches and door handles", "Learn the names of {n} new tools or apps", "Do a quick {n}-minute stretch at your desk", "Put away laundry that's been sitting out", "Write {n} things you want to do this weekend", "Take {n} minutes to relax without any screens",
  ],
  medium: [
    "Study for {n} minutes every day this week", "Read {n} chapters of a book this week", "Cook {n} homemade dinners this week", "Walk {n} minutes a day for a week", "Write {n} words toward a project this week", "Do {n} coding exercises this week", "Practice an instrument for {n} minutes daily this week", "Read {n} pages every day for a week", "Declutter {n} rooms this week", "Do {n} focused 25-minute work sessions this week",
    "Learn {n} new words in a language every day this week", "Journal every evening for {n} days", "Meal-prep lunches for {n} days", "Complete {n} lessons of an online course this week", "Draft {n} sections of a report this week", "Read {n} work or research articles this week", "Practice public speaking {n} times this week", "Do {n} home workouts this week", "Write {n} blog-post drafts this week", "Sketch or draw {n} times this week",
    "Clean and organize {n} cupboards this week", "Wake up before 7am on {n} days this week", "Read for {n} minutes before bed every day this week", "Cook a new recipe {n} times this week", "Do {n} stretching sessions this week", "Keep screen time under {n} hours a day this week", "Study a language for {n} minutes daily this week", "Finish {n} pending tasks from your to-do list this week", "Write {n} pages of a story this week", "Practice typing for {n} minutes daily this week",
    "Take a {n}-minute walk after dinner every day this week", "Review your budget and cut {n} unnecessary expenses", "Read {n} articles about a topic you want to master", "Do {n} practice problems for a subject this week", "Tidy your workspace at the end of {n} workdays", "Prepare a presentation with {n} slides this week", "Practice a hobby for {n} minutes daily this week", "Do {n} sessions of distraction-free deep work this week", "Read {n} pages of a non-fiction book this week", "Cook and freeze {n} meals for busy days",
    "Write and send {n} thoughtful emails this week", "Study flashcards for {n} minutes daily this week", "Complete {n} chapters of a workbook this week", "Do {n} loads of laundry and put them all away this week", "Learn {n} new songs on an instrument this week", "Walk {n} steps a day for a week", "Read and take notes on {n} chapters this week", "Plan the next day the night before for {n} days", "Do {n} short runs this week", "Organize {n} folders of digital files this week",
    "Write {n} journal entries about your progress this week", "Practice a language conversation for {n} minutes this week", "Finish {n} home-improvement tasks this week", "Read {n} chapters and summarize each this week", "Cook breakfast at home on {n} days this week", "Do {n} creative writing prompts this week", "Complete {n} modules of a certification this week", "Declutter and donate {n} bags of items this week", "Practice mental math for {n} minutes daily this week", "Do {n} yoga or stretching sessions this week",
    "Read {n} short stories this week", "Write {n} pages of class notes this week", "Prepare {n} home-cooked meals this week", "Take {n} walks in nature this week", "Do {n} 30-minute study blocks this week", "Learn to cook {n} new dishes this week", "Practice drawing for {n} minutes every day this week", "Read {n} chapters and discuss one with a friend", "Finish {n} overdue admin tasks this week", "Do {n} instrument practice sessions this week",
    "Write {n} words in your journal every day this week", "Clean {n} areas of your home thoroughly this week", "Complete {n} coding katas this week", "Take notes on {n} lectures or videos this week", "Do {n} sets of bodyweight exercises this week", "Read {n} pages of a challenging book this week", "Make a weekly plan and follow it for {n} days", "Cook dinner from scratch {n} times this week", "Write {n} paragraphs of an essay this week", "Practice a presentation {n} times before giving it",
    "Do {n} rounds of 15-minute decluttering this week", "Read {n} pages of a biography this week", "Learn {n} keyboard shortcuts and use them daily", "Have {n} home-cooked lunches instead of takeout this week", "Write a summary of {n} things you learned this week", "Practice a foreign language for {n} minutes daily this week", "Complete {n} practice quizzes this week", "Do {n} brisk 20-minute walks this week", "Organize your photos into {n} albums this week", "Read {n} chapters of a skill-building book this week",
    "Cook {n} vegetarian meals this week", "Write {n} pages of a personal project this week", "Do {n} pomodoro study sessions this week", "Practice singing for {n} minutes every day this week", "Finish reading {n} long articles this week", "Reset your room every night for {n} nights", "Complete {n} exercises from a course this week", "Do {n} stretching routines before bed this week", "Read {n} pages aloud to practice this week", "Shop from a grocery list {n} times this week",
    "Write {n} short reflections about your day this week", "Do {n} 10-minute tidying sprints this week", "Practice a craft for {n} minutes daily this week", "Read {n} chapters and write a review this week", "Cook {n} new breakfasts this week", "Do {n} focused reading sessions this week", "Learn {n} new vocabulary sets this week", "Complete {n} tasks from a bigger project this week", "Take {n} evening walks this week", "Practice instrument scales for {n} minutes daily this week",
    "Read {n} pages of a self-study guide this week", "Do {n} rounds of exercise this week", "Write {n} pages of journaling this week", "Organize {n} shelves or storage areas this week", "Cook and eat at home for {n} days this week", "Complete {n} lessons in a language app this week", "Do {n} 25-minute deep-work blocks this week", "Read a chapter before your phone on {n} mornings this week", "Practice writing for {n} minutes daily this week", "Take notes on {n} podcast episodes this week",
    "Do {n} tidying tasks around the house this week", "Read {n} pages of a productivity book this week", "Prepare {n} meals in advance this week", "Write {n} emails you've been avoiding this week", "Practice a language out loud for {n} minutes daily this week", "Complete {n} online tutorials this week", "Do {n} short workouts before work this week", "Read {n} chapters of a novel this week", "Study for {n} hours total this week", "Draw or paint {n} pieces this week",
    "Do {n} focused sessions on a side project this week", "Read and annotate {n} articles this week", "Cook {n} dinners with a new ingredient this week", "Write {n} pages of a report this week", "Practice public speaking to a mirror {n} times this week", "Declutter {n} categories of belongings this week", "Wake up early on {n} days this week", "Read {n} pages of a classic book this week", "Complete {n} coding challenges this week", "Take {n} thinking walks this week",
    "Prepare home lunches for {n} workdays this week", "Write {n} journal pages about your goals this week", "Do {n} stretching sessions after work this week", "Read {n} chapters and teach one idea to someone", "Practice an instrument on {n} days this week", "Complete {n} modules of study material this week", "Do {n} 15-minute cleaning bursts this week", "Read {n} pages of a language textbook this week", "Cook {n} homemade dinners with vegetables this week", "Write and revise {n} paragraphs this week",
  ],
  hard: [
    "Study {n} hours total this month", "Read {n} full books this month", "Write {n} words toward a big project this month", "Complete an online course of {n} lessons this month", "Wake up before 6am every day for {n} days straight", "Run {n} kilometers total this month", "Read a set number of pages every single day for {n} days", "Keep a {n}-day streak of daily journaling", "Practice an instrument for {n} minutes every day for a month", "Finish writing {n} chapters of a book this month",
    "Complete {n} coding projects this month", "Study a language every day for {n} days without missing one", "Do {n} workouts this month", "Read {n} research papers and summarize each this month", "Write a {n}-page report or thesis section this month", "Do {n} days of focused reading in a row", "Complete {n} certification modules this month", "Cook every dinner at home for {n} days straight", "Go {n} consecutive days without social media", "Read {n} non-fiction books and take notes this month",
    "Write {n} blog posts and publish them this month", "Practice public speaking {n} times this month", "Keep a {n}-day streak of morning workouts", "Learn {n} new songs on an instrument this month", "Finish {n} online tutorials and build something with each", "Study {n} chapters of a textbook thoroughly this month", "Walk {n} steps every day for a month", "Write {n} pages of a novel this month", "Complete {n} practice exams this month", "Do {n} days of waking early and exercising",
    "Read {n} pages of technical material this month", "Build a project with at least {n} features this month", "Do {n} deep-work sessions of 90 minutes this month", "Keep a {n}-day streak of reading before bed", "Learn {n} new skills and practice each this month", "Write {n} short stories this month", "Complete {n} weeks of a structured study plan", "Cook {n} home meals in a row without takeout", "Read a book series of {n} books this month", "Practice a language for {n} minutes daily for a month",
    "Finish {n} major tasks on a long-term project this month", "Keep a {n}-day streak of daily exercise", "Write {n} pages of a portfolio this month", "Study for {n} consecutive days without skipping", "Complete {n} chapters of an online course this month", "Read {n} classic novels this month", "Do {n} coding challenges this month", "Practice drawing every day for {n} days", "Write and edit {n} essays this month", "Walk or run {n} minutes every day for a month",
    "Learn {n} chapters of music theory this month", "Complete {n} modules and pass every quiz this month", "Do {n} days of a consistent morning routine", "Read {n} pages of a foreign-language book this month", "Build and publish {n} small projects this month", "Do {n} two-hour study sessions this month", "Write {n} pages of a research project this month", "Keep a {n}-day streak of journaling and reflection", "Cook {n} new recipes from scratch this month", "Practice an instrument for {n} hours total this month",
    "Read {n} books outside your usual genre this month", "Complete {n} coding katas this month", "Do {n} consecutive days of early rising", "Write {n} chapters of a guide or manual this month", "Study {n} lessons of advanced material this month", "Do {n} one-hour walks this month", "Finish {n} courses or certifications this month", "Read {n} pages of dense academic text this month", "Practice a language until you can hold a {n}-minute conversation", "Complete {n} distraction-free deep-focus days this month",
    "Write {n} words of a memoir or long essay this month", "Do {n} strength workouts this month", "Read and review {n} books this month", "Build a habit and keep it for {n} days straight", "Study {n} chapters and test yourself on each", "Go {n} days without any takeout or delivery", "Write {n} pages of a screenplay this month", "Complete {n} advanced tutorials this month", "Present to an audience {n} times this month", "Read a set number of pages every morning for {n} days straight",
    "Do {n} consecutive days of focused practice", "Finish {n} large sections of a personal project this month", "Learn {n} advanced concepts and apply each", "Write {n} detailed articles this month", "Do {n} weeks of consistent daily study", "Read {n} biographies this month", "Complete {n} rounds of a difficult workout plan", "Study a subject for {n} hours a week for a month", "Write and publish {n} pieces of content this month", "Do {n} days of a strict no-screen evening",
    "Read {n} technical books this month", "Practice an instrument every day for {n} days without missing", "Complete {n} milestones on a major goal this month", "Do {n} intense study weekends this month", "Write {n} chapters and get feedback on each this month", "Learn {n} programming concepts and build examples", "Read enough daily to finish {n} books this month", "Do {n} consecutive early mornings with a workout", "Complete a course with {n} assignments this month", "Write {n} pages of a dissertation or long report this month",
    "Practice a craft for {n} hours total this month", "Read {n} challenging chapters every week this month", "Do {n} full-length practice tests this month", "Build a {n}-part project and finish every part this month", "Study {n} vocabulary sets and master each this month", "Do {n} days of disciplined deep work", "Write {n} short essays and revise each this month", "Read {n} long-form articles and summarize each this month", "Complete {n} weeks of an intensive plan", "Practice public speaking for {n} minutes every day this month",
    "Do {n} 45-minute workouts this month", "Read {n} pages of philosophy or theory this month", "Finish {n} creative projects this month", "Study {n} advanced lessons and apply each this month", "Write {n} pages toward a book every week this month", "Keep a {n}-day streak with no missed study day", "Read {n} books and write a review for each this month", "Complete {n} coding projects with tests this month", "Practice a piece until you can play it perfectly {n} times", "Do {n} consecutive days of a full morning routine",
    "Write {n} thousand words of fiction this month", "Read {n} chapters of a dense manual this month", "Complete {n} modules and a final project this month", "Do {n} hard workouts in a row without skipping", "Study {n} topics deeply and teach each to someone", "Write {n} polished articles for a portfolio this month", "Read {n} pages of a foreign-language novel this month", "Do {n} three-hour deep-work marathons this month", "Finish {n} big projects at home this month", "Practice daily for {n} days and record your progress",
    "Read {n} academic chapters and take detailed notes", "Complete {n} levels of a skill course this month", "Do {n} consecutive days of early rising and reading", "Write {n} pages of a technical guide this month", "Study for a total of {n} hours this month", "Read {n} full-length books and discuss each this month", "Practice an instrument daily for {n} days in a row", "Go {n} weeks without breaking your study streak", "Write and finish {n} complete drafts this month", "Complete {n} demanding assignments this month",
    "Read {n} pages of research every day for a month", "Do {n} long weekend study sessions this month", "Build {n} features into a personal app this month", "Practice public speaking until you can present for {n} minutes", "Study {n} difficult topics and master each", "Do {n} consecutive days of disciplined practice", "Write {n} in-depth blog posts this month", "Complete {n} full practice projects this month", "Study a language for {n} hours total this month", "Finish {n} major goals on your long-term plan this month",
  ],
};

/** Every library goal across all difficulties (used for validation). */
export const ALL_LIBRARY_GOALS: string[] = [
  ...GOAL_LIBRARY.easy,
  ...GOAL_LIBRARY.medium,
  ...GOAL_LIBRARY.hard,
];

const GOAL_NUMBER_TOKEN = '{n}';
/** Does a library goal contain a numeric slot the user must fill? */
export function goalHasNumber(template: string): boolean {
  return template.includes(GOAL_NUMBER_TOKEN);
}
/** A readable version of a template for the dropdown (shows the slot as "N"). */
export function displayGoalTemplate(template: string): string {
  return template.replace(GOAL_NUMBER_TOKEN, 'N');
}
/** Fill the numeric slot with the user's number to get the final goal title. */
export function fillGoalNumber(template: string, n: string | number): string {
  const s = String(n).trim();
  return template.replace(GOAL_NUMBER_TOKEN, s.length ? s : 'N');
}

/* ──────────────────────────────── App-block penalty (solo goals) ── */

/** An app the user can choose to have blocked if a solo goal is not completed. */
export interface AppBlockTarget {
  /** Android package name — used by the native blocker. */
  packageName: string;
  label: string;
}

/** Common distracting apps offered as the block target. `packageName` is the
 *  real Android id so the native plugin can enforce the block. */
export const APP_BLOCK_TARGETS: AppBlockTarget[] = [
  { packageName: 'com.instagram.android', label: 'Instagram' },
  { packageName: 'com.zhiliaoapp.musically', label: 'TikTok' },
  { packageName: 'com.google.android.youtube', label: 'YouTube' },
  { packageName: 'com.facebook.katana', label: 'Facebook' },
  { packageName: 'com.twitter.android', label: 'X (Twitter)' },
  { packageName: 'com.snapchat.android', label: 'Snapchat' },
  { packageName: 'com.reddit.frontpage', label: 'Reddit' },
  { packageName: 'com.netflix.mediaclient', label: 'Netflix' },
  { packageName: 'com.discord', label: 'Discord' },
  { packageName: 'tv.twitch.android.app', label: 'Twitch' },
  { packageName: 'com.pinterest', label: 'Pinterest' },
  { packageName: 'com.spotify.music', label: 'Spotify' },
];

/** How long the chosen app stays blocked when a solo goal is missed. */
export const BLOCK_DURATIONS: { label: string; minutes: number }[] = [
  { label: '1 hour', minutes: 60 },
  { label: '3 hours', minutes: 180 },
  { label: '6 hours', minutes: 360 },
  { label: '12 hours', minutes: 720 },
  { label: '24 hours', minutes: 1440 },
];

/* ────────────────────────────────────────────────────── Message tones ── */

export interface ToneOption {
  id: MessageTone;
  label: string;
  blurb: string;
}

/** The three safe, legally-cautious tones. No shaming/insulting tone exists. */
export const TONE_OPTIONS: ToneOption[] = [
  {
    id: 'neutral',
    label: 'Neutral',
    blurb: 'A plain factual note that the goal was not completed in time.',
  },
  {
    id: 'supportive',
    label: 'Supportive',
    blurb: 'Adds a gentle nudge to send encouragement and help them get back on track.',
  },
  {
    id: 'firm',
    label: 'Firm',
    blurb: 'States clearly that they asked to be told if they missed the commitment.',
  },
];

/* ──────────────────────────────────────────────────────────── Themes ── */

export const THEMES: { id: ThemeId; name: string; premium: boolean; swatch: string[] }[] = [
  { id: 'cyberpunk-mint', name: 'Cyberpunk Mint', premium: false, swatch: ['#0D1111', '#40FFAA', '#00E0FF'] },
  { id: 'default', name: 'Comitra Green', premium: false, swatch: ['#FFFFFF', '#16A34A', '#1F2937'] },
  { id: 'midnight-indigo', name: 'Midnight Indigo', premium: false, swatch: ['#0E1220', '#5B8CFF', '#38D3FF'] },
  { id: 'arctic-frost', name: 'Arctic Frost', premium: false, swatch: ['#F4F8FB', '#0EA5B7', '#3B82F6'] },
  { id: 'monochrome-slate', name: 'Monochrome Slate', premium: true, swatch: ['#101214', '#C8D2DC', '#96BEDC'] },
  { id: 'solar-flare', name: 'Solar Flare', premium: true, swatch: ['#161006', '#FFB020', '#FF6A3D'] },
  { id: 'crimson-ember', name: 'Crimson Ember', premium: true, swatch: ['#160C0C', '#FF5C5C', '#FF9166'] },
  { id: 'royal-gold', name: 'Royal Gold', premium: true, swatch: ['#12100A', '#E7C349', '#B8863B'] },
  { id: 'forest-moss', name: 'Forest Moss', premium: true, swatch: ['#0C1410', '#4ADE80', '#84CC16'] },
  { id: 'deep-ocean', name: 'Deep Ocean', premium: true, swatch: ['#08131A', '#22D3EE', '#2DD4BF'] },
];
