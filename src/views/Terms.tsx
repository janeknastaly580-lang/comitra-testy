import type { ReactNode } from 'react';
import PageHeader from '../components/PageHeader';
import { Card } from '../components/ui';

const EFFECTIVE_DATE = 'July 19, 2026';
const SUPPORT_EMAIL = 'janeknastaly580@gmail.com';

/**
 * Comitra — Terms of Use for the SUBSCRIPTION / social-commitment model.
 * Not a final legal opinion, but it clearly states the rules: no money is staked,
 * the app is for personal goals, and messages are consent-based.
 */
export default function Terms() {
  return (
    <div className="phone-scroll h-full overflow-y-auto px-4 py-5">
      <PageHeader title="Terms of Use" back />

      <Card className="mb-4 p-5">
        <p className="font-mono text-[11px] uppercase tracking-widest text-muted">Effective date</p>
        <p className="mt-1 text-sm font-semibold text-ink">{EFFECTIVE_DATE}</p>
        <p className="mt-3 text-sm leading-relaxed text-muted">
          Comitra is a goal-accountability app. You set a goal, a judge confirms whether
          you completed it, and if you don't, people you chose in advance (and who agreed) may receive
          a message. By using Comitra you agree to these Terms.
        </p>
      </Card>

      <div className="space-y-4">
        <Section n="1" title="Comitra is not gambling">
          <P>
            Comitra is <B>not</B> a game of chance and is not a gambling service. Nothing you do in
            the app depends on luck, and there is no prize pool.
          </P>
        </Section>

        <Section n="2" title="No money is staked on goals">
          <P>
            There are <B>no deposits, no stakes, no pots, no bets, no tokens, no winnings and no
            physical or material rewards</B> in Comitra. Completing a goal does not earn you money,
            tokens, rewards or any other financial benefit, and there is no redistribution of value
            between users.
          </P>
        </Section>

        <Section n="3" title="The subscription is a fee for using the app">
          <P>
            Comitra is offered as a subscription. New accounts get a free trial; after it, a
            subscription of <B>$4.99 per month</B> is required to create new goals. The fee
            is payment for using the app's features only — it is never a stake, wager or deposit on
            any specific goal, and it is never paid out to anyone.
          </P>
          <P>
            Without an active subscription you can still log in, view your existing goals, finish an
            already-active goal, and manage your data and consents — you just can't create new goals.
          </P>
        </Section>

        <Section n="4" title="Keep goals action-based and appropriate">
          <P>
            Comitra is for personal goals — habits, study, work, projects, consistency and similar
            action-based commitments. Comitra should not be used to disclose especially private
            information to other people. We may block or refuse to activate a goal that appears to
            reveal sensitive matters (for example health/medical information, diagnoses, medication,
            therapy, addictions, sexual matters, religion, politics, financial situation, children's
            data, violence, self-harm or eating disorders).
          </P>
        </Section>

        <Section n="5" title="Respect other people">
          <P>You may not use Comitra to:</P>
          <List
            items={[
              'harass, humiliate, threaten or intimidate anyone;',
              'violate anyone’s personal rights or dignity;',
              'disclose another person’s private data without a lawful basis.',
            ]}
          />
          <P>
            Even the "firm" message tone is kept respectful. Messages never contain insults, moral
            judgements or shaming language.
          </P>
        </Section>

        <Section n="6" title="Judges and recipients take part voluntarily">
          <P>
            The judge you choose must accept the role before a goal can start, and may decline. Each
            recipient must accept before they can ever receive a message. Judges and recipients may
            refuse to take part.
          </P>
        </Section>

        <Section n="7" title="Recipients can withdraw consent at any time">
          <P>
            A recipient may withdraw consent at any time using the "I don't want to receive messages
            anymore" link in any message or on their recipient page. After that, we stop sending them
            notifications from that user. We keep the historical records needed for security,
            complaints and compliance, but we do not use a withdrawn contact for further
            notifications.
          </P>
        </Section>

        <Section n="8" title="How messages work">
          <P>
            A message is sent to a recipient only if all of these are true: the judge marked the goal
            as not completed; the recipient had accepted; and the recipient had not withdrawn consent.
            Before a goal starts you choose the message tone and see a preview of exactly what would be
            sent. By default the message does not reveal your goal's content unless you explicitly turn
            that on.
          </P>
        </Section>

        <Section n="9" title="Your responsibility for content">
          <P>
            You are responsible for the goals you create and the content you enter. Comitra may block
            goals that break these rules. You confirm you have a lawful basis to share the contact
            details of the judge and recipients you add.
          </P>
        </Section>

        <Section n="10" title="No professional advice">
          <P>
            Comitra does not provide medical, psychological, dietary/nutritional or legal advice, and
            does not diagnose, treat or replace a doctor, therapist or other professional. It is a
            general accountability tool for personal goals.
          </P>
        </Section>

        <Section n="11" title="Changes and contact">
          <P>
            We may update these Terms from time to time; the effective date above shows when they last
            changed. Questions? Contact <Mail>{SUPPORT_EMAIL}</Mail>.
          </P>
        </Section>
      </div>
    </div>
  );
}

/* presentational helpers (match Privacy) */

function Section({ n, title, children }: { n: string; title: string; children: ReactNode }) {
  return (
    <Card className="p-5">
      <div className="mb-3 flex items-baseline gap-2">
        <span className="font-mono text-xs font-bold text-accent">{n}.</span>
        <h2 className="text-base font-bold tracking-tight text-ink">{title}</h2>
      </div>
      <div className="space-y-3">{children}</div>
    </Card>
  );
}
function P({ children }: { children: ReactNode }) {
  return <p className="text-sm leading-relaxed text-muted">{children}</p>;
}
function B({ children }: { children: ReactNode }) {
  return <span className="font-semibold text-ink">{children}</span>;
}
function List({ items }: { items: string[] }) {
  return (
    <ul className="space-y-1.5">
      {items.map((item, i) => (
        <li key={i} className="flex gap-2 text-sm leading-relaxed text-muted">
          <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-accent" />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}
function Mail({ children }: { children: string }) {
  return (
    <a href={`mailto:${children}`} className="text-accent hover:underline">
      {children}
    </a>
  );
}
