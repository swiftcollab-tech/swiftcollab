import React from 'react';

const EFFECTIVE_DATE = '6 November 2026';

const privacySections = [
  {
    title: '1. Scope',
    body: (
      <p>
        This Privacy Policy explains how SwiftCollab ("SwiftCollab", "we", "us", or "our")
        collects, uses, stores, and shares information when you use our AI orchestration service,
        website, and connected-app features (together, the "Service"). It applies to account
        holders, invited organization members, and people who contact us for support.
      </p>
    ),
  },
  {
    title: '2. Information we collect',
    body: (
      <div className="space-y-3">
        <p><strong>Account and organization data.</strong> Name, email address, password hash, organization membership, role, invitation status, and account preferences.</p>
        <p><strong>Connected-app data.</strong> OAuth access and refresh tokens, granted scopes, connected account and site identifiers, and the content needed to perform your requested actions. Credentials are encrypted at rest.</p>
        <p><strong>Service content.</strong> Prompts, chat history, action plans, confirmations, tool results, files or records you choose to process, and audit information about actions performed through SwiftCollab.</p>
        <p><strong>Technical and support data.</strong> IP address, browser and device information, timestamps, diagnostics, security logs, and communications you send to support.</p>
      </div>
    ),
  },
  {
    title: '3. How we use information',
    body: (
      <ul className="list-disc space-y-2 pl-6">
        <li>Provide, secure, troubleshoot, and improve the Service.</li>
        <li>Authenticate users, manage organizations and roles, and process invitations.</li>
        <li>Connect third-party services and carry out user-approved or organization-authorized actions.</li>
        <li>Generate AI-assisted responses, action plans, monitoring suggestions, and execution results.</li>
        <li>Prevent abuse, investigate incidents, comply with law, and enforce our Terms.</li>
        <li>Send transactional messages such as invitations, security alerts, and service notices.</li>
      </ul>
    ),
  },
  {
    title: '4. AI and connected services',
    body: (
      <p>
        SwiftCollab may send the minimum context reasonably needed to an AI provider or a connected
        service to answer a request or perform an action. Connected services, such as Atlassian Jira,
        Google, GitHub, Slack, or services accessed through an integration provider, process data under
        their own terms and privacy policies. Review an action carefully before approving it, especially
        when it creates, changes, sends, or deletes information in another service.
      </p>
    ),
  },
  {
    title: '5. How we share information',
    body: (
      <p>
        We share information only as needed with infrastructure, database, email, AI, monitoring, and
        integration providers that help operate the Service; with connected services at your direction;
        with your organization administrators where appropriate; during a corporate transaction; or when
        required to protect rights, safety, security, or comply with law. We do not sell personal data.
      </p>
    ),
  },
  {
    title: '6. Retention and deletion',
    body: (
      <p>
        We retain information while your account or organization uses the Service and for a reasonable
        period afterward for security, backup, dispute resolution, and legal obligations. Organization
        administrators may control organization records. Disconnecting an app removes its active stored
        credentials, but related audit or chat records may remain until deleted under the applicable
        retention process. You may request deletion by contacting us.
      </p>
    ),
  },
  {
    title: '7. Security',
    body: (
      <p>
        We use reasonable administrative and technical safeguards, including access controls, encrypted
        transport, password hashing, and encryption of stored integration credentials. No online service
        is completely secure, so we cannot guarantee absolute security. Please report suspected misuse
        promptly and keep your credentials confidential.
      </p>
    ),
  },
  {
    title: '8. Your choices and rights',
    body: (
      <p>
        Depending on your location, you may have rights to access, correct, delete, restrict, or obtain a
        copy of your personal data, or object to certain processing. You can disconnect integrations from
        the Service and revoke access from the connected provider. Contact us to make a request. We may
        need to verify your identity and consider your organization administrator's responsibilities.
      </p>
    ),
  },
  {
    title: '9. International processing and children',
    body: (
      <p>
        Our providers may process information in countries other than yours. By using the Service, you
        understand that data may be transferred subject to appropriate legal safeguards. The Service is
        intended for business users and is not directed to children under 18.
      </p>
    ),
  },
  {
    title: '10. Changes and contact',
    body: (
      <p>
        We may update this policy as the Service evolves. We will revise the effective date and provide
        additional notice when appropriate. Questions or privacy requests can be sent to{' '}
        <a className="text-cyan-300 hover:underline" href="mailto:admin@swiftcollab.tech">admin@swiftcollab.tech</a>.
      </p>
    ),
  },
];

const termsSections = [
  {
    title: '1. Agreement and eligibility',
    body: (
      <p>
        These Terms of Service ("Terms") govern access to SwiftCollab's AI orchestration service,
        website, and connected-app features (the "Service"). By creating an account, accepting an
        invitation, or using the Service, you agree to these Terms. You must be at least 18 and authorized
        to accept these Terms for yourself or the organization you represent.
      </p>
    ),
  },
  {
    title: '2. Accounts and organizations',
    body: (
      <p>
        You must provide accurate information, protect your credentials, and promptly notify us of
        unauthorized use. Organization owners and administrators control membership, roles, connected
        accounts, and organization data. If you join an organization, its administrators may manage your
        access and content. You are responsible for actions taken through your account.
      </p>
    ),
  },
  {
    title: '3. Connected services and authorization',
    body: (
      <p>
        You may authorize SwiftCollab to access third-party services. You confirm that you have the rights
        and permissions needed to connect each account and process its data. You may revoke a connection
        at any time. Third-party services are governed by their own terms, may change without notice, and
        may limit or suspend SwiftCollab's access.
      </p>
    ),
  },
  {
    title: '4. AI output and automated actions',
    body: (
      <p>
        AI output can be incomplete, inaccurate, or unsuitable. You must review important output and
        confirmations before relying on it. SwiftCollab may require confirmation before sensitive actions,
        but you remain responsible for instructions you submit and actions you approve. Do not use the
        Service as a substitute for professional legal, medical, financial, or safety advice.
      </p>
    ),
  },
  {
    title: '5. Acceptable use',
    body: (
      <ul className="list-disc space-y-2 pl-6">
        <li>Do not violate law, third-party rights, provider policies, or contractual restrictions.</li>
        <li>Do not access accounts or data without authorization or bypass security and usage controls.</li>
        <li>Do not introduce malware, disrupt the Service, probe for vulnerabilities without permission, or misuse credentials.</li>
        <li>Do not use the Service for fraud, harassment, harmful surveillance, spam, or unlawful discrimination.</li>
        <li>Do not resell or reverse engineer the Service except where applicable law expressly permits it.</li>
      </ul>
    ),
  },
  {
    title: '6. Your content and our service',
    body: (
      <p>
        You retain ownership of content you submit. You grant us the limited rights needed to host,
        process, transmit, and display that content to operate and secure the Service. You represent that
        you have the necessary rights to provide it. SwiftCollab and its licensors retain all rights in the
        Service, software, branding, and documentation. Feedback may be used without restriction.
      </p>
    ),
  },
  {
    title: '7. Availability and changes',
    body: (
      <p>
        The Service is under active development. Features, limits, integrations, or pricing may change,
        and beta features may be modified or discontinued. We aim for reliable operation but do not
        promise uninterrupted or error-free availability. Scheduled maintenance and third-party outages
        may affect the Service.
      </p>
    ),
  },
  {
    title: '8. Suspension and termination',
    body: (
      <p>
        You may stop using the Service at any time. We may restrict or suspend access when reasonably
        necessary to address security risks, unlawful activity, material breach, non-payment, or harm to
        the Service or others. On termination, your right to use the Service ends. Provisions that by their
        nature should survive will remain in effect.
      </p>
    ),
  },
  {
    title: '9. Disclaimers and limitation of liability',
    body: (
      <p>
        To the maximum extent permitted by law, the Service is provided "as is" and "as available" without
        warranties of merchantability, fitness for a particular purpose, non-infringement, or accuracy.
        SwiftCollab is not responsible for third-party services or actions taken based on AI output. To the
        maximum extent permitted by law, SwiftCollab will not be liable for indirect, incidental, special,
        consequential, exemplary, or punitive damages, or loss of data, revenue, profits, or goodwill.
      </p>
    ),
  },
  {
    title: '10. General terms and contact',
    body: (
      <p>
        These Terms and any service-specific agreement form the entire agreement about the Service. If a
        provision is unenforceable, the remaining provisions continue. You may not assign these Terms
        without our consent. We may update these Terms and will provide notice when appropriate; continued
        use after an update means you accept the revised Terms. Questions can be sent to{' '}
        <a className="text-cyan-300 hover:underline" href="mailto:admin@swiftcollab.tech">admin@swiftcollab.tech</a>.
      </p>
    ),
  },
];

export default function LegalPage({ type }) {
  const isPrivacy = type === 'privacy';
  const title = isPrivacy ? 'Privacy Policy' : 'Terms of Service';
  const sections = isPrivacy ? privacySections : termsSections;

  return (
    <main className="min-h-screen bg-slate-950 px-5 py-10 text-slate-200 sm:px-8">
      <div className="mx-auto max-w-4xl">
        <header className="mb-10 border-b border-slate-800 pb-8">
          <a href="/" className="inline-flex items-center gap-2 text-xl font-semibold text-white hover:text-cyan-300">
            <span className="h-3 w-3 rounded-full bg-cyan-400" />
            SwiftCollab
          </a>
          <h1 className="mt-8 text-4xl font-bold tracking-tight text-white">{title}</h1>
          <p className="mt-3 text-sm text-slate-400">Effective and last updated: {EFFECTIVE_DATE}</p>
        </header>

        <article className="space-y-9 leading-7 text-slate-300">
          {sections.map(section => (
            <section key={section.title}>
              <h2 className="mb-3 text-xl font-semibold text-white">{section.title}</h2>
              {section.body}
            </section>
          ))}
        </article>

        <footer className="mt-14 flex flex-wrap gap-x-5 gap-y-2 border-t border-slate-800 pt-7 text-sm text-slate-400">
          <a className="hover:text-cyan-300" href="/">Return to SwiftCollab</a>
          <a className="hover:text-cyan-300" href="/privacy">Privacy Policy</a>
          <a className="hover:text-cyan-300" href="/terms">Terms of Service</a>
          <a className="hover:text-cyan-300" href="mailto:admin@swiftcollab.tech">Contact support</a>
        </footer>
      </div>
    </main>
  );
}
