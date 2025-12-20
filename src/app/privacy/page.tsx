/* eslint-disable react/no-unescaped-entities */
export default function PrivacyPage() {
  return (
    <div className="relative min-h-screen overflow-hidden bg-[#fdf8f2]">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute -left-10 top-10 h-64 w-64 rounded-full bg-primary/20 blur-pill" />
        <div className="absolute right-0 top-24 h-56 w-56 rounded-full bg-primary/15 blur-pill" />
      </div>
      <div className="relative mx-auto max-w-4xl space-y-6 px-6 py-16 sm:px-10">
        <div className="space-y-2">
          <h1 className="text-3xl font-semibold text-foreground">Privacy Policy</h1>
          <p className="text-muted">Last Updated: December 12, 2025</p>
          <p className="text-muted">MyMeals ("us", "we", or "our") operates the Mealo mobile application (the "Service"). This page informs you of our policies regarding the collection, use, and disclosure of personal data when you use our Service and the choices you have associated with that data.</p>
        </div>
        <div className="space-y-4 text-sm leading-relaxed text-muted">
          <section>
            <h2 className="text-lg font-semibold text-foreground">1. Information Collection and Use</h2>
            <p>We collect several different types of information for various purposes to provide and improve our Service to you.</p>
            <h3 className="text-base font-semibold text-foreground mt-2">Types of Data Collected</h3>
            <p><span className="font-semibold text-foreground">Personal Data:</span> While using our Service, we may ask you to provide us with certain personally identifiable information that can be used to contact or identify you ("Personal Data"). Personally identifiable information may include, but is not limited to: Email address, First name and last name, Cookies and Usage Data.</p>
            <p className="mt-2"><span className="font-semibold text-foreground">Usage Data:</span> When you access the Service with a mobile device, we may collect certain information automatically, including, but not limited to, the type of mobile device you use, your mobile device unique ID, the IP address of your mobile device, your mobile operating system, the type of mobile Internet browser you use, unique device identifiers and other diagnostic data.</p>
          </section>
          <section>
            <h2 className="text-lg font-semibold text-foreground">2. Use of Data</h2>
            <p>Mealo uses the collected data for various purposes:</p>
            <ul className="list-disc pl-5 mt-2 space-y-1">
              <li>To provide and maintain the Service</li>
              <li>To notify you about changes to our Service</li>
              <li>To allow you to participate in interactive features of our Service when you choose to do so</li>
              <li>To provide customer care and support</li>
              <li>To provide analysis or valuable information so that we can improve the Service</li>
              <li>To monitor the usage of the Service</li>
              <li>To detect, prevent and address technical issues</li>
            </ul>
          </section>
          <section>
            <h2 className="text-lg font-semibold text-foreground">3. Transfer of Data</h2>
            <p>Your information, including Personal Data, may be transferred to — and maintained on — computers located outside of your state, province, country or other governmental jurisdiction where the data protection laws may differ than those from your jurisdiction.</p>
          </section>
          <section>
            <h2 className="text-lg font-semibold text-foreground">4. Disclosure of Data</h2>
            <p>Mealo may disclose your Personal Data in the good faith belief that such action is necessary to:</p>
            <ul className="list-disc pl-5 mt-2 space-y-1">
              <li>To comply with a legal obligation</li>
              <li>To protect and defend the rights or property of Mealo</li>
              <li>To prevent or investigate possible wrongdoing in connection with the Service</li>
              <li>To protect the personal safety of users of the Service or the public</li>
              <li>To protect against legal liability</li>
            </ul>
          </section>
          <section>
            <h2 className="text-lg font-semibold text-foreground">5. Security of Data</h2>
            <p>The security of your data is important to us, but remember that no method of transmission over the Internet, or method of electronic storage is 100% secure. While we strive to use commercially acceptable means to protect your Personal Data, we cannot guarantee its absolute security.</p>
          </section>
          <section>
            <h2 className="text-lg font-semibold text-foreground">6. Service Providers</h2>
            <p>We may employ third party companies and individuals to facilitate our Service ("Service Providers"), to provide the Service on our behalf, to perform Service-related services or to assist us in analyzing how our Service is used. These third parties have access to your Personal Data only to perform these tasks on our behalf and are obligated not to disclose or use it for any other purpose.</p>
          </section>
          <section>
            <h2 className="text-lg font-semibold text-foreground">7. Children's Privacy</h2>
            <p>Our Service does not address anyone under the age of 18 ("Children"). We do not knowingly collect personally identifiable information from anyone under the age of 18. If you are a parent or guardian and you are aware that your Children has provided us with Personal Data, please contact us.</p>
          </section>
          <section>
            <h2 className="text-lg font-semibold text-foreground">8. Changes to This Privacy Policy</h2>
            <p>We may update our Privacy Policy from time to time. We will notify you of any changes by posting the new Privacy Policy on this page. You are advised to review this Privacy Policy periodically for any changes. Changes to this Privacy Policy are effective when they are posted on this page.</p>
          </section>
          <section>
            <h2 className="text-lg font-semibold text-foreground">9. Contact Us</h2>
            <p>If you have any questions about this Privacy Policy, please contact us at support@mealo.app.</p>
          </section>
        </div>
      </div>
    </div>
  );
}
