import type { ReactNode } from 'react';
import PageHeader from '../components/PageHeader';
import { Card } from '../components/ui';

/**
 * Comitra — Privacy Policy.
 *
 * A GDPR-first document (per the "equal to GDPR" strategy) with dedicated
 * regional appendices for the EU/UK, the USA (CCPA/CPRA), Brazil (LGPD) and
 * Canada (PIPEDA). Written to satisfy Apple App Store and Google Play data-
 * disclosure requirements. Update EFFECTIVE_DATE and the two operator
 * placeholders (legal name + registered address) before publishing.
 */

const EFFECTIVE_DATE = 'July 17, 2026';

/** Contact address for all privacy matters. */
const PRIVACY_EMAIL = 'janeknastaly50@gmail.com';

/** Registered operator of the service. */
const OPERATOR_LEGAL_NAME = 'Jan Nastały';
const OPERATOR_ADDRESS = 'Złota 17, 80-297 Banino, Poland';

export default function Privacy() {
  return (
    // This page renders directly inside PhoneFrame (outside AppLayout), so it must
    // provide its own scroll container — otherwise the fixed-height frame clips it.
    <div className="phone-scroll h-full overflow-y-auto px-4 py-5">
      <PageHeader title="Privacy Policy" back />

      <Card className="mb-4 p-5">
        <p className="font-mono text-[11px] uppercase tracking-widest text-muted">
          Effective date
        </p>
        <p className="mt-1 text-sm font-semibold text-ink">{EFFECTIVE_DATE}</p>
        <p className="mt-3 text-sm leading-relaxed text-muted">
          This Privacy Policy explains how Comitra (&ldquo;Comitra&rdquo;,
          &ldquo;we&rdquo;, &ldquo;us&rdquo; or &ldquo;our&rdquo;) collects, uses,
          shares and protects your personal information when you use the Comitra
          mobile application, website and any related services (together, the
          &ldquo;Service&rdquo;). Please read it carefully. If you do not agree
          with it, please do not use the Service.
        </p>
      </Card>

      <div className="space-y-4">
        <Section n="1" title="Who we are and who this policy covers">
          <P>
            The Service is a goal-accountability tool that lets you set
            goals, choose a judge to confirm whether you completed them,
            and choose people who may be notified if a goal is not completed. There
            are no deposits, stakes or rewards — it is a paid subscription.
          </P>
          <P>
            <B>Data controller / administrator.</B> {OPERATOR_LEGAL_NAME} is the
            entity responsible for your personal data processed through the
            Service, with a registered address at {OPERATOR_ADDRESS}.
          </P>
          <P>
            <B>Contact for privacy matters.</B> You can reach us about anything in
            this policy, or to exercise your rights, at{' '}
            <Mail>{PRIVACY_EMAIL}</Mail>.
          </P>
          <P>
            <B>Scope.</B> This policy applies to the Comitra mobile application
            (including the Android app), our website, and all associated features
            and services. It does not apply to third-party services we link to,
            which are governed by their own policies (see Section 16).
          </P>
        </Section>

        <Section n="2" title="What data we collect">
          <P>We collect the following categories of data, grouped by source.</P>
          <SubTitle>a. Data you provide directly</SubTitle>
          <List
            items={[
              'Account data: email address and a display name.',
              'Authentication data: a password (when you register with email) that you set yourself.',
              'Profile data: optional bio and a profile photo (either a preset avatar or an image you upload).',
              'Content you enter: goals (title, description, deadline), the message tone you choose, and any proof of completion you add.',
              'Judge and recipient data: the name and contact details (e.g. phone number or email) of the judge you nominate and of the people you choose to be notified. You are responsible for having a lawful basis to share another person’s details with us, and each of them must accept before taking part.',
              'Support and community data: messages you send us, feature requests you post, votes you cast, and tester applications you submit.',
            ]}
          />
          <SubTitle>b. Data from third parties</SubTitle>
          <List
            items={[
              'Google Sign-In (OAuth): if you choose to sign in with Google, we receive your verified email address, your name, your Google profile picture, and your Google account identifier. We do not receive your Google password.',
              'Payment processor: when you subscribe, our payment provider confirms to us whether a transaction succeeded, the amount and currency. We never receive or store your full card or bank details.',
            ]}
          />
          <SubTitle>c. Data collected automatically (device data)</SubTitle>
          <List
            items={[
              'A device identifier (a unique ID generated on first launch) used for security and our anti-cheat referee isolation check.',
              'IP address, device and operating-system version, and app version.',
              'Technical logs and diagnostic/crash information needed to keep the Service secure and working.',
              'Usage analytics collected via Google Analytics (such as which screens you open and general interaction events), used to understand and improve the Service. This is used with your consent where the law requires it.',
            ]}
          />
          <SubTitle>d. Derived data</SubTitle>
          <P>
            The Service analyses your own goals and their completion times to
            generate insights, statistics and effectiveness reports for you (for
            example, your motivation peaks, completion rates by weekday, and
            judge patterns). This derived data is produced from
            information you already gave us and is presented back to you inside
            the app. See Section 13 on automated processing.
          </P>
          <Callout>
            <B>No sensitive data, please.</B> Comitra is a general productivity
            tool. You should not enter special-category data into it — including
            health, medical, biometric, racial or ethnic, political, religious,
            sexual-orientation, or precise-location information.
          </Callout>
        </Section>

        <Section n="3" title="Why we use your data and our legal bases">
          <P>
            Under the EU/UK GDPR we must have a legal basis for each use. We rely
            on the following.
          </P>
          <SubTitle>Performance of a contract (Art. 6(1)(b) GDPR)</SubTitle>
          <List
            items={[
              'Creating and maintaining your account and letting you log in.',
              'Providing the core features: creating goals, sending judge and recipient links, recording judge decisions, sending consent-based notifications, and processing your subscription.',
            ]}
          />
          <SubTitle>Legitimate interests (Art. 6(1)(f) GDPR)</SubTitle>
          <List
            items={[
              'Keeping the Service and accounts secure — detecting unauthorised logins, preventing fraud and cheating (including the device-isolation referee check).',
              'Diagnosing errors, maintaining and improving the Service, and understanding aggregate usage.',
            ]}
          />
          <SubTitle>Consent (Art. 6(1)(a) GDPR)</SubTitle>
          <List
            items={[
              'Sending you marketing push notifications or newsletter emails.',
              'Optional analytics and any non-essential cookies/storage.',
            ]}
          />
          <P>
            You can withdraw consent at any time (see Section 5) without affecting
            the lawfulness of processing before withdrawal.
          </P>
        </Section>

        <Section n="4" title="Who we share your data with">
          <P>
            We do not sell your personal information. We do share it with the
            following categories of recipients, only as needed to run the Service.
          </P>
          <List
            items={[
              'Infrastructure providers: cloud hosting and database providers that store data on our behalf.',
              'Communications providers: services that deliver our system emails and push notifications.',
              'Analytics and diagnostics providers: we use Google Analytics (provided by Google) to understand how the Service is used and to detect crashes and errors. Google processes this data under its own privacy policy and may set identifiers on your device.',
              'Payment / subscription provider (for example an app store, Stripe or RevenueCat), which processes the subscription and returns transaction results under its own privacy policy. It handles your payment credentials; we never see them.',
              'Legal and safety: authorities, regulators or law-enforcement bodies where we are legally required to disclose data, or to protect our rights, users or the public.',
              'Business transfers: a successor entity if Comitra is involved in a merger, acquisition or sale of assets (you will be notified of any change of controller).',
            ]}
          />
          <P>
            We place appropriate contracts (such as data-processing agreements)
            with the processors that handle personal data on our behalf.
          </P>
        </Section>

        <Section n="5" title="Your rights">
          <P>
            Depending on where you live, you have some or all of the following
            rights over your personal data:
          </P>
          <List
            items={[
              'Access — obtain a copy of your data (for example, by exporting your goal history from the app).',
              'Rectification — correct inaccurate or incomplete information (you can edit your name, bio, avatar and other profile details in the app).',
              'Erasure ("right to be forgotten") — delete your account and associated data.',
              'Withdraw consent — change your mind at any time, for example by turning off push notifications.',
              'Restriction and objection — ask us to limit or stop certain processing based on legitimate interests.',
              'Data portability — receive your data in a portable, machine-readable form.',
              'Non-discrimination — we will not penalise you for exercising your privacy rights.',
            ]}
          />
          <SubTitle>How to exercise them</SubTitle>
          <P>
            You can delete your account yourself at any time: open{' '}
            <B>Profile → Delete account</B> in the app. This one-tap action
            disables the account and removes access to it. You can also correct
            most information directly in <B>Profile → Edit</B>. For any other
            request — access, portability, objection or restriction — email us at{' '}
            <Mail>{PRIVACY_EMAIL}</Mail> and we will respond within the time
            required by law (generally one month under the GDPR).
          </P>
          <SubTitle>Right to complain</SubTitle>
          <P>
            If you believe we process your data unlawfully, you have the right to
            lodge a complaint with your local data-protection authority. In Poland
            this is the President of the Personal Data Protection Office (Prezes
            Urzędu Ochrony Danych Osobowych, PUODO). EU residents may also contact
            the authority in their country of residence.
          </P>
        </Section>

        <Section n="6" title="International data transfers">
          <P>
            We and some of our providers may process data on servers located
            outside your country, including outside the European Economic Area
            (EEA), such as in the United States. Where we transfer personal data
            of individuals in the EEA/UK to a country without an adequacy decision,
            we rely on appropriate safeguards — primarily the Standard Contractual
            Clauses (SCCs) approved by the European Commission (and the UK
            International Data Transfer Addendum where relevant) — to protect your
            data. You can request a copy of the safeguards we use by emailing{' '}
            <Mail>{PRIVACY_EMAIL}</Mail>.
          </P>
        </Section>

        <Section n="7" title="How long we keep your data">
          <P>
            We keep your personal data for as long as your account is active. After
            you delete your account, we remove or irreversibly anonymise your
            personal data within 30 days, except where we must keep certain records
            longer to meet legal, tax, accounting or fraud-prevention obligations
            (for example, payment records).
          </P>
          <P>
            Insights and report data tied to your account are deleted with the
            account. We may retain aggregated, anonymised statistics that can no
            longer identify you (for example, overall success-rate trends) to
            understand and improve the Service.
          </P>
        </Section>

        <Section n="8" title="Data security">
          <P>
            We apply industry-standard measures to protect your data, including
            encryption of connections in transit (HTTPS/TLS), secure HTTP headers,
            rate limiting and CSRF protection on our payment API, and restricted
            administrative access to our databases. No method of transmission or
            storage is ever completely secure, so we cannot guarantee absolute
            security, but we work to protect your information and to notify you and
            the relevant authorities of a breach where the law requires.
          </P>
        </Section>

        <Section n="9" title="Children's privacy">
          <P>
            The Service is not directed to, and not intended for, anyone under the
            age of 16. We do not knowingly collect personal data from children
            under 16. If we learn that we have collected data from a child under
            16 without appropriate consent, we will delete the account and its data
            promptly. If you believe a child has provided us with personal data,
            please contact us at <Mail>{PRIVACY_EMAIL}</Mail>.
          </P>
        </Section>

        <Section n="10" title="Cookies, tokens and local storage">
          <P>
            The Service uses cookies and similar technologies, including your
            device&rsquo;s local storage. We group them as follows:
          </P>
          <List
            items={[
              'Strictly necessary: session and authentication tokens (including those used for Google Sign-In and our anti-CSRF payment cookie) and locally stored settings that keep you logged in and the app working. These cannot be switched off without breaking the Service.',
              'Optional analytics: we use Google Analytics, which sets cookies or similar identifiers to measure how the Service is used. These are used only with your consent where the law requires it, and you can decline them.',
            ]}
          />
          <P>
            You can clear cookies and local storage through your browser or device
            settings, but doing so may log you out and reset your local
            preferences.
          </P>
        </Section>

        <Section n="11" title="Marketing and notifications">
          <P>
            We send two kinds of messages. <B>Transactional</B> messages
            (for example, judge decisions, deadline reminders, security and
            account notices) are part of the Service. <B>Marketing</B> push
            notifications and newsletter emails are sent only with your consent,
            and you can opt out at any time from your device notification settings,
            an unsubscribe link, or by contacting us.
          </P>
        </Section>

        <Section n="12" title="Automated processing and profiling">
          <P>
            As described in Section 2(d), the Service automatically analyses your
            goals and completion times to build insights and effectiveness reports
            for you. This profiling is used purely for analytical purposes inside
            the app, to deliver value to you.
          </P>
          <P>
            This automated processing does <B>not</B> produce legal effects
            concerning you and does not similarly significantly affect you. It has
            no bearing on your creditworthiness, insurance, employment, or any
            other external decision about you.
          </P>
        </Section>

        <Section n="13" title="We do not sell your personal information">
          <P>
            We do not sell your personal information for money. Some privacy laws
            (notably in California) define &ldquo;sale&rdquo; and &ldquo;sharing&rdquo;
            broadly to include certain disclosures to analytics
            partners — for example, our use of Google Analytics may be treated as
            &ldquo;sharing&rdquo; under California law. Where such activity applies,
            we treat it as covered by the opt-out rights described in the United
            States appendix below, and we honour opt-out preference signals such as
            Global Privacy Control (GPC) where legally required.
          </P>
        </Section>

        <Section n="14" title="Do Not Track and Global Privacy Control">
          <P>
            Some browsers send a &ldquo;Do Not Track&rdquo; (DNT) signal. There is
            no common industry standard for how to respond to it, and our Service
            does not track you across other companies&rsquo; websites, so we do
            not currently respond to DNT signals. Where legally required, we do
            recognise Global Privacy Control (GPC) signals as a valid request to
            opt out of the &ldquo;sale&rdquo;/&ldquo;sharing&rdquo; of personal
            information.
          </P>
        </Section>

        <Section n="15" title="Links to third-party services">
          <P>
            The Service may contain links to third-party sites and services — for
            example, messaging apps (WhatsApp, Messenger) used to send a judge or
            recipient link. Once
            you follow such a link, you are subject to that third party&rsquo;s own
            privacy policy and terms. We do not control and are not responsible for
            the privacy practices of those third parties. We encourage you to read
            their policies before providing them with any data.
          </P>
        </Section>

        <Section n="16" title="Regional appendices">
          <P>
            The main policy above is built to GDPR standards and applies to
            everyone. The following appendices add rights and disclosures specific
            to certain regions. Where an appendix conflicts with the main policy
            for a resident of that region, the appendix controls for that person.
          </P>

          <SubTitle>A. Europe (EU/UK GDPR)</SubTitle>
          <List
            items={[
              'Controller: see Section 1. Legal bases: see Section 3 (Art. 6(1)(b) contract, Art. 6(1)(f) legitimate interests, Art. 6(1)(a) consent).',
              'Your rights: access, rectification, erasure, restriction, objection, portability and withdrawal of consent (Section 5).',
              'International transfers rely on the European Commission’s Standard Contractual Clauses and the UK IDTA (Section 6).',
              'You may complain to your national supervisory authority — in Poland, PUODO (Section 5).',
            ]}
          />

          <SubTitle>B. United States (California CCPA/CPRA and similar state laws)</SubTitle>
          <P>
            If you are a California resident, you have the right to know what
            personal information we collect, to access and delete it, to correct
            it, and to opt out of any &ldquo;sale&rdquo; or &ldquo;sharing&rdquo;
            of it. Residents of states such as Virginia, Colorado, Connecticut and
            others have comparable rights.
          </P>
          <List
            items={[
              'Categories collected in the last 12 months: identifiers (email, name, device ID, IP), account and profile data, user-generated content (goals, judge and recipient details), commercial data (subscription transactions), internet/usage and diagnostic data, and inferences (your derived insights). See Section 2.',
              'Disclosed for a business purpose to: infrastructure, communications, analytics/diagnostics and payment providers, and legal authorities (Section 4).',
              'We do not sell personal information for money. To opt out of any "sale"/"sharing" as those terms are defined under California law, email us at ' + PRIVACY_EMAIL + ' or send a Global Privacy Control signal (Sections 13 and 14).',
              'Non-discrimination: we will not deny you the Service, charge you a different price, or give you a lower quality of service for exercising your privacy rights.',
            ]}
          />
          <P>
            To exercise these rights, email <Mail>{PRIVACY_EMAIL}</Mail>. We will
            verify your request against your account details before acting on it,
            and you may use an authorised agent where the law allows.
          </P>

          <SubTitle>C. Brazil (LGPD)</SubTitle>
          <P>
            If you are in Brazil, the LGPD gives you rights similar to the GDPR —
            including confirmation of processing, access, correction,
            anonymisation or deletion, portability, information about sharing, and
            withdrawal of consent. You may exercise them by contacting{' '}
            <Mail>{PRIVACY_EMAIL}</Mail>, and you may petition the national
            authority (ANPD).
          </P>

          <SubTitle>D. Canada (PIPEDA)</SubTitle>
          <P>
            If you are in Canada, we handle your personal information in accordance
            with PIPEDA. We use clear, plain language, collect only what we need
            for the purposes described here, and do not process your data in hidden
            ways. You may request access to or correction of your information, and
            may complain to the Office of the Privacy Commissioner of Canada.
          </P>
        </Section>

        <Section n="17" title="Changes to this policy">
          <P>
            We may update this Privacy Policy from time to time. The
            &ldquo;Effective date&rdquo; at the top shows when it last changed. If
            we make material changes, we will notify you before they take effect —
            for example, by email or an in-app push notification or notice. Your
            continued use of the Service after an update means you accept the
            revised policy.
          </P>
        </Section>

        <Card className="p-5">
          <p className="text-sm leading-relaxed text-muted">
            Questions about this policy or your data? Contact us at{' '}
            <Mail>{PRIVACY_EMAIL}</Mail>.
          </p>
          <p className="mt-3 font-mono text-[11px] uppercase tracking-widest text-muted">
            Last updated {EFFECTIVE_DATE}
          </p>
        </Card>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────── presentational helpers ── */

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

function SubTitle({ children }: { children: ReactNode }) {
  return (
    <p className="pt-1 font-mono text-[11px] uppercase tracking-widest text-ink/80">{children}</p>
  );
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

function Callout({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-accent/40 bg-accent/5 p-3 text-sm leading-relaxed text-muted">
      {children}
    </div>
  );
}

function Mail({ children }: { children: string }) {
  return (
    <a href={`mailto:${children}`} className="text-accent hover:underline">
      {children}
    </a>
  );
}
