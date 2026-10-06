import { useState, useEffect } from 'react';
import { Store, Wallet, ShoppingCart, Package, BarChart3, WifiOff, Receipt, Users, ArrowRight, Shield, Smartphone, Star, ChevronDown, AlertTriangle, TrendingDown, PackageX, Zap, Globe, BadgeCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Link } from 'react-router-dom';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { InstallPWAButton } from '@/components/InstallPWAButton';

const features = [
  { icon: ShoppingCart, title: 'Quick POS', desc: 'Ring up sales in seconds with search, categories, and discounts.' },
  { icon: Package, title: 'Stock Tracking', desc: 'Real-time inventory with low-stock alerts and bulk import.' },
  { icon: Receipt, title: 'Quotations', desc: 'Create professional quotes and convert them to sales instantly.' },
  { icon: Users, title: 'Debtors Book', desc: 'Track credit sales and partial payments per customer.' },
  { icon: BarChart3, title: 'Sales Reports', desc: 'Daily, monthly, and exportable CSV reports with profit tracking.' },
  { icon: WifiOff, title: 'Works Offline', desc: 'Keep selling even without internet — data syncs when you reconnect.' },
];

const painPoints = [
  {
    icon: AlertTriangle,
    title: 'Forgetting who owes you?',
    desc: 'Sale Point tracks every credit sale and partial payment automatically.',
    color: 'text-amber-500',
    bg: 'bg-amber-500/10',
  },
  {
    icon: PackageX,
    title: 'Stock disappearing without a trace?',
    desc: 'Get instant alerts when items run low. Know exactly what sold and when.',
    color: 'text-red-500',
    bg: 'bg-red-500/10',
  },
  {
    icon: TrendingDown,
    title: 'No idea which products make profit?',
    desc: 'See your best sellers, margins, and daily revenue at a glance.',
    color: 'text-orange-500',
    bg: 'bg-orange-500/10',
  },
];

const testimonials = [
  {
    name: 'Mwila C.',
    business: 'Grocery Store, Lusaka',
    quote: "I used to write sales in a book and forget who owed me. Sale Point saved me thousands in lost debts.",
    rating: 5,
  },
  {
    name: 'Thandiwe M.',
    business: 'Hair Salon, Kitwe',
    quote: "Even when ZESCO cuts power and the internet goes down, I keep recording sales. It just works.",
    rating: 5,
  },
  {
    name: 'Joseph B.',
    business: 'Hardware Shop, Ndola',
    quote: "The stock alerts alone are worth it. I never run out of my best-selling items anymore.",
    rating: 5,
  },
];

const differentiators = [
  { icon: WifiOff, title: '100% Offline', desc: 'Most POS systems die without internet. Sale Point doesn\'t.' },
  { icon: Smartphone, title: 'Phone-First', desc: 'Designed for your phone — no expensive equipment needed.' },
  { icon: Globe, title: 'Zambian Kwacha', desc: 'Native ZMW support. No USD conversion headaches.' },
  { icon: Zap, title: 'WhatsApp Receipts', desc: 'Share digital receipts with customers instantly.' },
];

const faqs = [
  { q: 'Do I need internet to use Sale Point?', a: 'No! Sale Point works 100% offline. Record sales, check stock, and manage debts without any internet connection. Your data syncs automatically when you reconnect.' },
  { q: 'Can I use it on my phone?', a: 'Yes — Sale Point is designed for phones first. It works on any smartphone, tablet, or laptop with a browser. No app download needed.' },
  { q: 'What happens after the free trial?', a: 'After your 3-day free trial, simply subscribe to keep all your data and features. If you don\'t subscribe, your account is paused until you do.' },
  { q: 'Is my data safe?', a: 'Absolutely. Your data is encrypted and stored securely in the cloud. Only you can access your business information.' },
  { q: 'Can I export my data?', a: 'Yes! Export your sales history, product list, and reports as CSV files anytime. Your data belongs to you.' },
];

const steps = [
  { num: '1', title: 'Sign Up', desc: 'Create your account in 30 seconds.' },
  { num: '2', title: 'Add Products', desc: 'Enter your inventory or import via CSV.' },
  { num: '3', title: 'Start Selling', desc: 'Use POS on any phone, tablet, or laptop.' },
];

const Index = () => {
  const [showSticky, setShowSticky] = useState(false);

  useEffect(() => {
    const handleScroll = () => {
      setShowSticky(window.scrollY > 400);
    };
    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  return (
    <div className="min-h-screen bg-background">
      {/* Hero */}
      <section className="flex flex-col items-center justify-center px-6 pt-16 pb-12 text-center">
        <div className="inline-flex items-center justify-center w-20 h-20 rounded-3xl bg-primary mb-6 shadow-xl">
          <Store className="w-10 h-10 text-primary-foreground" />
        </div>
        <h1 className="text-4xl font-display font-bold text-foreground mb-3">Sale Point</h1>
        <p className="text-lg text-muted-foreground mb-2 max-w-sm">
          The simple Point of Sale built for Zambian businesses.
        </p>
        <p className="text-sm text-muted-foreground mb-4 max-w-xs">
          Track sales, stock, debts, and expenses — all from your phone.
        </p>

        {/* Social proof badge */}
        <div className="inline-flex items-center gap-2 bg-primary/10 text-primary rounded-full px-4 py-1.5 text-sm font-medium mb-6">
          <BadgeCheck className="w-4 h-4" />
          Trusted by 50+ Zambian businesses
        </div>

        <div className="w-full max-w-xs space-y-3">
          <Link to="/auth?tab=register" className="block">
            <Button variant="pos" size="xl" className="w-full">
              Start Free Trial <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
          </Link>
          <Link to="/auth?tab=login" className="block">
            <Button variant="pos-outline" size="lg" className="w-full">
              Login — I have an account
            </Button>
          </Link>
          <InstallPWAButton
            variant="outline"
            size="lg"
            className="w-full"
            label="Install"
          />
          <p className="text-sm text-muted-foreground">
            3-day free trial • No card needed • Cancel anytime
          </p>
        </div>
      </section>

      {/* Loss Aversion / Pain Points */}
      <section className="px-6 py-12 bg-destructive/5">
        <h2 className="text-2xl font-display font-bold text-center mb-2">Are you losing money?</h2>
        <p className="text-sm text-muted-foreground text-center mb-8 max-w-md mx-auto">
          Most small business owners lose money every month from forgotten debts, missing stock, and no sales records.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 max-w-3xl mx-auto">
          {painPoints.map(p => (
            <Card key={p.title} className="border-0 shadow-sm">
              <CardContent className="p-5 text-center">
                <div className={`w-12 h-12 rounded-xl ${p.bg} flex items-center justify-center mx-auto mb-3`}>
                  <p.icon className={`w-6 h-6 ${p.color}`} />
                </div>
                <h3 className="font-semibold text-sm mb-1">{p.title}</h3>
                <p className="text-xs text-muted-foreground leading-relaxed">{p.desc}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      {/* Competitive Differentiators */}
      <section className="px-6 py-12">
        <h2 className="text-2xl font-display font-bold text-center mb-2">Why Sale Point beats the alternatives</h2>
        <p className="text-sm text-muted-foreground text-center mb-8">No more pen & paper. No expensive POS hardware.</p>
        <div className="grid grid-cols-2 gap-3 max-w-lg mx-auto">
          {differentiators.map(d => (
            <div key={d.title} className="flex flex-col items-center text-center p-4 rounded-xl bg-muted/50">
              <d.icon className="w-6 h-6 text-primary mb-2" />
              <h3 className="font-semibold text-sm mb-1">{d.title}</h3>
              <p className="text-xs text-muted-foreground">{d.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Features */}
      <section className="px-6 py-12 bg-muted/50">
        <h2 className="text-2xl font-display font-bold text-center mb-8">Everything you need to run your shop</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 max-w-4xl mx-auto">
          {features.map(f => (
            <Card key={f.title} className="border-0 shadow-sm">
              <CardContent className="p-5 flex gap-4 items-start">
                <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
                  <f.icon className="w-5 h-5 text-primary" />
                </div>
                <div>
                  <h3 className="font-semibold text-sm mb-1">{f.title}</h3>
                  <p className="text-xs text-muted-foreground leading-relaxed">{f.desc}</p>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      {/* How it works */}
      <section className="px-6 py-12">
        <h2 className="text-2xl font-display font-bold text-center mb-8">Get started in 3 steps</h2>
        <div className="flex flex-col sm:flex-row gap-6 max-w-2xl mx-auto">
          {steps.map(s => (
            <div key={s.num} className="flex-1 text-center">
              <div className="w-12 h-12 rounded-full bg-primary text-primary-foreground font-bold text-lg flex items-center justify-center mx-auto mb-3">
                {s.num}
              </div>
              <h3 className="font-semibold mb-1">{s.title}</h3>
              <p className="text-sm text-muted-foreground">{s.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Testimonials */}
      <section className="px-6 py-12 bg-muted/50">
        <h2 className="text-2xl font-display font-bold text-center mb-8">What business owners say</h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 max-w-4xl mx-auto">
          {testimonials.map(t => (
            <Card key={t.name} className="border-0 shadow-sm">
              <CardContent className="p-5">
                <div className="flex gap-0.5 mb-3">
                  {Array.from({ length: t.rating }).map((_, i) => (
                    <Star key={i} className="w-4 h-4 fill-amber-400 text-amber-400" />
                  ))}
                </div>
                <p className="text-sm text-foreground mb-4 italic">"{t.quote}"</p>
                <div>
                  <p className="text-sm font-semibold">{t.name}</p>
                  <p className="text-xs text-muted-foreground">{t.business}</p>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      {/* CTA */}
      <section className="px-6 py-12">
        <div className="max-w-sm mx-auto text-center">
          <h2 className="text-2xl font-display font-bold mb-2">Start your free trial today</h2>
          <p className="text-sm text-muted-foreground mb-6">No credit card required. Cancel anytime.</p>
          <Card className="shadow-lg border-primary/20">
            <CardContent className="p-8">
              <ul className="text-sm text-left space-y-2 mb-6">
                {['Unlimited sales & products', 'Offline mode', 'Quotations & receipts', 'Debtor tracking', 'Sales reports & CSV export', 'Push notifications', 'WhatsApp receipt sharing'].map(f => (
                  <li key={f} className="flex items-center gap-2">
                    <span className="text-primary font-bold">✓</span> {f}
                  </li>
                ))}
              </ul>
              <Link to="/auth?tab=register">
                <Button variant="pos" size="lg" className="w-full">
                  Start 3-Day Free Trial
                </Button>
              </Link>
              <p className="text-xs text-muted-foreground mt-3">No credit card required</p>
            </CardContent>
          </Card>
        </div>
      </section>

      {/* Trust signals */}
      <section className="px-6 py-8">
        <div className="flex flex-wrap items-center justify-center gap-6 text-xs text-muted-foreground max-w-md mx-auto">
          <div className="flex items-center gap-1.5">
            <Shield className="w-4 h-4 text-primary" />
            <span>Your data is safe</span>
          </div>
          <div className="flex items-center gap-1.5">
            <Smartphone className="w-4 h-4 text-primary" />
            <span>Works on any phone</span>
          </div>
          <div className="flex items-center gap-1.5">
            <WifiOff className="w-4 h-4 text-primary" />
            <span>100% offline capable</span>
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section className="px-6 py-12 bg-muted/50">
        <h2 className="text-2xl font-display font-bold text-center mb-8">Frequently asked questions</h2>
        <div className="max-w-lg mx-auto">
          <Accordion type="single" collapsible className="w-full">
            {faqs.map((faq, i) => (
              <AccordionItem key={i} value={`faq-${i}`}>
                <AccordionTrigger className="text-sm text-left">{faq.q}</AccordionTrigger>
                <AccordionContent className="text-sm text-muted-foreground">{faq.a}</AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </div>
      </section>

      {/* Affiliate CTA */}
      <section className="px-6 py-12">
        <div className="max-w-sm mx-auto text-center">
          <Wallet className="w-10 h-10 text-primary mx-auto mb-3" />
          <h2 className="text-xl font-display font-bold mb-2">Earn with Sale Point</h2>
          <p className="text-sm text-muted-foreground mb-4">
            Refer businesses and earn commission on every subscription.
          </p>
          <Link to="/affiliate-auth">
            <Button variant="outline" size="lg" className="w-full">
              <Wallet className="h-4 w-4 mr-2" /> Become an Affiliate
            </Button>
          </Link>
        </div>
      </section>

      {/* Footer */}
      <footer className="px-6 py-8 pb-24 sm:pb-8 border-t text-center text-xs text-muted-foreground">
        <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2 mb-3 max-w-lg mx-auto">
          <Link to="/pos-system-zambia" className="hover:text-primary">POS System Zambia</Link>
          <Link to="/point-of-sale-software-zambia" className="hover:text-primary">POS Software Zambia</Link>
          <Link to="/free-offline-pos-zambia" className="hover:text-primary">Free Offline POS</Link>
          <Link to="/restaurant-pos-zambia" className="hover:text-primary">Restaurant POS</Link>
          <Link to="/inventory-management-zambia" className="hover:text-primary">Inventory Management</Link>
          <Link to="/debtors-credit-sales-zambia" className="hover:text-primary">Debtors Management</Link>
        </div>
        <div className="mb-3">
          <Link to="/privacy-policy" className="hover:text-primary">Privacy Policy</Link>
        </div>
        <p>Product of MC Sale Point Solutions</p>
        <p>© {new Date().getFullYear()} Sale Point. Built for Zambian businesses.</p>
      </footer>

      {/* Sticky mobile CTA */}
      <div className={`fixed bottom-0 left-0 right-0 bg-background/95 backdrop-blur-sm border-t p-3 sm:hidden transition-transform duration-300 z-50 ${showSticky ? 'translate-y-0' : 'translate-y-full'}`}>
        <Link to="/auth?tab=register" className="block">
          <Button variant="pos" size="lg" className="w-full">
            Start Free Trial — It's Free <ArrowRight className="ml-2 h-4 w-4" />
          </Button>
        </Link>
      </div>
    </div>
  );
};

export default Index;
