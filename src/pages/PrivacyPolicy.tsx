import { useEffect } from "react";
import { Link } from "react-router-dom";
import { Store, ArrowLeft } from "lucide-react";
import { SITE_URL } from "@/lib/seoDefaults";

const sections = [
  {
    title: "1. Who we are",
    body: "Sale Point (\"Sale Point\", \"we\", \"our\" or \"us\") provides a point of sale (POS), invoicing and business management service for Zambian businesses. This Privacy Policy explains what information we collect when you use our website and app, how we use it, and the choices you have.",
  },
  {
    title: "2. Information we collect",
    body: "We collect information you give us directly, information collected automatically, and information about your business operations that is created while you use the service.",
    items: [
      "Account information: your name, email address, phone number, and a securely hashed password.",
      "Business information: your business name, address, logo, tax (TPIN) details, and settings you configure.",
      "Transaction data: products, prices, stock levels, sales, quotations, delivery notes, invoices, expenses, customers, and cashier activity you record in the app.",
      "Payment information: payment methods and amounts for sales. Card and mobile-money payment details are processed by licensed payment providers, not stored by us in plain text.",
      "Device and usage information: browser type, device type, language, and diagnostic data used to keep the service stable.",
    ],
  },
  {
    title: "3. Offline-first storage",
    body: "Sale Point is designed to work without an internet connection. To make this possible, some data may be stored locally on your device (for example products, stock and recent sales) so the shop keeps working even when the connection drops. This local data is managed by the app and is subject to the same access controls. When your device reconnects, changes are securely synchronised to our servers.",
  },
  {
    title: "4. How we use your information",
    body: "We use your information to provide and operate the service, including:",
    items: [
      "Creating and managing your account and business.",
      "Processing sales, invoices and payments.",
      "Synchronising data across your devices and the cloud.",
      "Sending service messages such as password resets or subscription notices.",
      "Improving the service, fixing bugs, and supporting you when you ask for help.",
      "Complying with legal and tax obligations in Zambia.",
    ],
  },
  {
    title: "5. When we share information",
    body: "We do not sell your or your customers' data. We share information only as needed to run the service:",
    items: [
      "Hosting and infrastructure providers that store data on our behalf under strict confidentiality terms.",
      "Payment and mobile-money providers (for example MTN, Airtel or Zamtel Mobile Money) to process transactions you authorise.",
      "Professional advisers and authorities, where required by Zambian law.",
    ],
  },
  {
    title: "6. Security",
    body: "We take reasonable technical and organisational measures to protect your data: encrypted connections (HTTPS), role-based access controls so only authorised staff of your business can view its data, and secure storage of passwords. No method of transmission or storage is 100% secure, but we work hard to keep your data safe.",
  },
  {
    title: "7. Data retention and deletion",
    body: "We keep your business data while your account is active so the service functions correctly. When you cancel your subscription or request deletion, we remove or anonymise your data where feasible. Note that once deleted, transactional history may be required to remain for legal or tax record-keeping purposes.",
  },
  {
    title: "8. Your rights",
    body: "Under the Zambian Data Protection Act (No. 3 of 2021) you have rights to access, correct, and delete your personal information, and to object to certain processing. You can manage much of this directly in the app (for example editing your business details or deleting products). To exercise any other right, contact us using the details below, and we will respond within a reasonable time.",
  },
  {
    title: "9. Cookies and local storage",
    body: "We use local storage and similar technologies to keep you signed in and to remember your preferences. We do not use advertising cookies. You can clear this data from your browser or device at any time, but the app may then ask you to sign in again.",
  },
  {
    title: "10. Children",
    body: "Our service is intended for use by adults running or working in businesses. We do not knowingly collect personal information from children.",
  },
  {
    title: "11. Changes to this policy",
    body: "We may update this policy from time to time. When we make significant changes, we will note the updated date at the top of this page and, where appropriate, notify you in the app. Continued use of the service after changes means you accept the updated policy.",
  },
  {
    title: "12. Contact us",
    body: "If you have questions or requests about this policy or your data, contact us at support@salepointpos.online. Please include your business details so we can verify your request promptly.",
  },
];

const PrivacyPolicy = () => {
  useEffect(() => {
    document.title = "Privacy Policy | Sale Point - POS Software for Zambia";
    const setMeta = (name: string, content: string) => {
      let el = document.head.querySelector<HTMLMetaElement>(`meta[name="${name}"]`);
      if (!el) {
        el = document.createElement("meta");
        el.setAttribute("name", name);
        document.head.appendChild(el);
      }
      el.setAttribute("content", content);
    };
    setMeta("description", "Privacy policy for the Sale Point point of sale system. Learn what data we collect, how it is used, and your rights under Zambian data protection law.");
    const canonical = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    if (canonical) canonical.setAttribute("href", `${SITE_URL}/privacy-policy`);
  }, []);

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b bg-background/95 backdrop-blur-sm sticky top-0 z-40">
        <div className="max-w-3xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center justify-center w-8 h-8 rounded-xl bg-primary">
              <Store className="w-4 h-4 text-primary-foreground" />
            </span>
            <span className="font-display font-bold text-foreground">Sale Point</span>
          </div>
          <Link to="/" className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1">
            <ArrowLeft className="w-4 h-4" /> Back to home
          </Link>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 py-10 animate-fade-in">
        <h1 className="text-3xl font-display font-bold text-foreground mb-2">Privacy Policy</h1>
        <p className="text-sm text-muted-foreground mb-8">Last updated: 22 September 2026</p>

        <div className="prose prose-sm max-w-none space-y-8">
          {sections.map((s) => (
            <section key={s.title}>
              <h2 className="text-lg font-semibold text-foreground mb-2">{s.title}</h2>
              <p className="text-sm text-muted-foreground leading-relaxed">{s.body}</p>
              {s.items && (
                <ul className="mt-3 space-y-1.5 text-sm text-muted-foreground">
                  {s.items.map((item, i) => (
                    <li key={i} className="flex gap-2">
                      <span className="text-primary font-bold">•</span>
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ))}
        </div>

        <div className="mt-12 pt-6 border-t text-center text-xs text-muted-foreground">
          <p>Product of MC Sale Point Solutions</p>
          <p>© {new Date().getFullYear()} Sale Point. Built for Zambian businesses.</p>
          <p className="mt-1">Questions? <a className="text-primary hover:underline" href="mailto:support@salepointpos.online">support@salepointpos.online</a></p>
        </div>
      </main>
    </div>
  );
};

export default PrivacyPolicy;