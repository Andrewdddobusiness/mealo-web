/* eslint-disable react/no-unescaped-entities */
export default function TermsPage() {
  return (
    <div className="relative min-h-screen overflow-hidden bg-[#fdf8f2]">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute -left-10 top-10 h-64 w-64 rounded-full bg-primary/20 blur-pill" />
        <div className="absolute right-0 top-24 h-56 w-56 rounded-full bg-primary/15 blur-pill" />
      </div>
      <div className="relative mx-auto max-w-4xl space-y-6 px-6 py-16 sm:px-10">
        <div className="space-y-2">
          <h1 className="text-3xl font-semibold text-foreground">Terms & Conditions</h1>
          <p className="text-muted">Last Updated: December 12, 2025</p>
          <p className="text-muted">Please read these Terms and Conditions ("Terms", "Terms and Conditions") carefully before using the Mealo mobile application (the "Service") operated by Mealo ("us", "we", or "our").</p>
          <p className="text-muted">Your access to and use of the Service is conditioned on your acceptance of and compliance with these Terms. These Terms apply to all visitors, users, and others who access or use the Service.</p>
        </div>
        <div className="space-y-4 text-sm leading-relaxed text-muted">
          <section>
            <h2 className="text-lg font-semibold text-foreground">1. Accounts</h2>
            <p>When you create an account with us, you must provide us information that is accurate, complete, and current at all times. Failure to do so constitutes a breach of the Terms, which may result in immediate termination of your account on our Service.</p>
            <p className="mt-2">You are responsible for safeguarding the password that you use to access the Service and for any activities or actions under your password, whether your password is with our Service or a third-party service.</p>
          </section>
          <section>
            <h2 className="text-lg font-semibold text-foreground">2. Content</h2>
            <p>Our Service allows you to post, link, store, share and otherwise make available certain information, text, graphics, videos, or other material ("Content"). You are responsible for the Content that you post to the Service, including its legality, reliability, and appropriateness.</p>
          </section>
          <section>
            <h2 className="text-lg font-semibold text-foreground">3. Prohibited Uses</h2>
            <p>You may use the Service only for lawful purposes and in accordance with Terms. You agree not to use the Service:</p>
            <ul className="list-disc pl-5 mt-2 space-y-1">
              <li>In any way that violates any applicable national or international law or regulation.</li>
              <li>To transmit, or procure the sending of, any advertising or promotional material, including any "junk mail", "chain letter," "spam," or any other similar solicitation.</li>
              <li>To impersonate or attempt to impersonate the Company, a Company employee, another user, or any other person or entity.</li>
            </ul>
          </section>
          <section>
            <h2 className="text-lg font-semibold text-foreground">4. Intellectual Property</h2>
            <p>The Service and its original content (excluding Content provided by users), features and functionality are and will remain the exclusive property of Mealo and its licensors. The Service is protected by copyright, trademark, and other laws of both the United States and foreign countries.</p>
          </section>
          <section>
            <h2 className="text-lg font-semibold text-foreground">5. Termination</h2>
            <p>We may terminate or suspend your account immediately, without prior notice or liability, for any reason whatsoever, including without limitation if you breach the Terms. Upon termination, your right to use the Service will immediately cease.</p>
          </section>
          <section>
            <h2 className="text-lg font-semibold text-foreground">6. Limitation of Liability</h2>
            <p>In no event shall Mealo, nor its directors, employees, partners, agents, suppliers, or affiliates, be liable for any indirect, incidental, special, consequential or punitive damages, including without limitation, loss of profits, data, use, goodwill, or other intangible losses, resulting from (i) your access to or use of or inability to access or use the Service; (ii) any conduct or content of any third party on the Service; (iii) any content obtained from the Service; and (iv) unauthorized access, use or alteration of your transmissions or content, whether based on warranty, contract, tort (including negligence) or any other legal theory, whether or not we have been informed of the possibility of such damage.</p>
          </section>
          <section>
            <h2 className="text-lg font-semibold text-foreground">7. Changes</h2>
            <p>We reserve the right, at our sole discretion, to modify or replace these Terms at any time. If a revision is material we will try to provide at least 30 days notice prior to any new terms taking effect. What constitutes a material change will be determined at our sole discretion.</p>
          </section>
          <section>
            <h2 className="text-lg font-semibold text-foreground">8. Contact Us</h2>
            <p>If you have any questions about these Terms, please contact us at support@mealo.app.</p>
          </section>
        </div>
      </div>
    </div>
  );
}
