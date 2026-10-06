import { useEffect } from "react";
import { Link } from "react-router-dom";
import type { ComponentType } from "react";
import { ArrowRight, Check } from "lucide-react";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import { SITE_URL } from "@/lib/seoDefaults";

export interface SeoFeature {
  title: string;
  desc: string;
  icon: ComponentType<{ className?: string }>;
}

export interface SeoStep {
  title: string;
  desc: string;
}

export interface SeoFaq {
  q: string;
  a: string;
}

export interface SeoComparisonRow {
  feature: string;
  point: string;
  other: string;
}

export interface SeoPageData {
  path: string;
  title: string;
  metaDescription: string;
  badge: string;
  h1: string;
  intro: string[];
  sections: { heading: string; body: string[] }[];
  features: SeoFeature[];
  steps: SeoStep[];
  comparison: SeoComparisonRow[];
  faqs: SeoFaq[];
  related: { path: string; label: string }[];
}

const url = (path: string): string => `${SITE_URL}${path}`;

function upsertMeta(attr: "name" | "property", key: string, content: string) {
  const selector = attr === "name" ? `meta[name="${key}"]` : `meta[property="${key}"]`;
  let el = document.head.querySelector<HTMLMetaElement>(selector);
  if (!el) {
    el = document.createElement("meta");
    el.setAttribute(attr, key);
    document.head.appendChild(el);
  }
  el.setAttribute("content", content);
}

function injectJsonLd(data: SeoPageData) {
  const existing = document.getElementById("seo-jsonld");
  if (existing) existing.remove();

  const graph: Record<string, unknown>[] = [
    {
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Home", item: url("/") },
        { "@type": "ListItem", position: 2, name: data.h1, item: url(data.path) },
      ],
    },
    {
      "@type": "WebPage",
      "@id": url(data.path) + "#webpage",
      url: url(data.path),
      name: data.title,
      description: data.metaDescription,
      inLanguage: "en",
      isPartOf: { "@id": url("/") + "#website" },
    },
  ];

  if (data.faqs.length > 0) {
    graph.push({
      "@type": "FAQPage",
      mainEntity: data.faqs.map((f) => ({
        "@type": "Question",
        name: f.q,
        acceptedAnswer: { "@type": "Answer", text: f.a },
      })),
    });
  }

  const script = document.createElement("script");
  script.type = "application/ld+json";
  script.id = "seo-jsonld";
  script.textContent = JSON.stringify({ "@context": "https://schema.org", "@graph": graph });
  document.head.appendChild(script);
}

export function useSeo(data: SeoPageData) {
  useEffect(() => {
    document.title = data.title;
    upsertMeta("name", "description", data.metaDescription);
    upsertMeta("property", "og:title", data.title);
    upsertMeta("property", "og:description", data.metaDescription);
    upsertMeta("property", "og:type", "website");
    upsertMeta("property", "og:url", url(data.path));
    upsertMeta("property", "og:image", url("/icon-512.png"));
    upsertMeta("property", "og:site_name", "Sale Point");
    upsertMeta("name", "twitter:card", "summary_large_image");
    upsertMeta("name", "twitter:title", data.title);
    upsertMeta("name", "twitter:description", data.metaDescription);
    upsertMeta("name", "twitter:image", url("/icon-512.png"));

    let canonical = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    if (!canonical) {
      canonical = document.createElement("link");
      canonical.setAttribute("rel", "canonical");
      document.head.appendChild(canonical);
    }
    canonical.setAttribute("href", url(data.path));

    injectJsonLd(data);
  }, [data]);
}

export default function SeoPage({ data }: { data: SeoPageData }) {
  useSeo(data);

  return (
    <div className="min-h-screen bg-background">
      {/* Nav */}
      <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur">
        <div className="max-w-4xl mx-auto flex items-center justify-between px-4 py-3">
          <Link to="/" className="font-display font-bold text-lg text-foreground">
            Sale <span className="text-primary">Point</span>
          </Link>
          <div className="flex items-center gap-2">
            <Link to="/auth?tab=login" className="text-sm text-muted-foreground hover:text-foreground px-2">
              Sign in
            </Link>
            <Link to="/auth?tab=register">
              <Button size="sm" variant="pos">Get Started Free</Button>
            </Link>
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 pb-16">
        {/* Breadcrumb */}
        <nav className="text-xs text-muted-foreground pt-5 mb-6 flex items-center gap-1.5" aria-label="Breadcrumb">
          <Link to="/" className="hover:text-primary">Home</Link>
          <span>/</span>
          <span className="text-foreground">{data.h1}</span>
        </nav>

        {/* Hero */}
        <section className="mb-8">
          <span className="inline-block bg-primary/10 text-primary text-xs font-bold uppercase tracking-wider px-3 py-1 rounded-full mb-4">
            {data.badge}
          </span>
          <h1 className="font-display font-extrabold text-3xl sm:text-4xl leading-tight text-foreground mb-4">
            {data.h1}
          </h1>
          {data.intro.map((p, i) => (
            <p key={i} className="text-muted-foreground leading-relaxed mb-3">{p}</p>
          ))}
          <div className="flex flex-col sm:flex-row gap-3 mt-6">
            <Link to="/auth?tab=register" className="sm:w-auto">
              <Button size="lg" className="w-full">
                Start Free Trial <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            </Link>
            <Link to="/auth?tab=login" className="sm:w-auto">
              <Button size="lg" variant="outline" className="w-full">Sign In to Your Shop</Button>
            </Link>
          </div>
        </section>

        {/* Content sections */}
        {data.sections.map((s) => (
          <section key={s.heading} className="mb-10">
            <h2 className="font-display font-bold text-2xl text-foreground mb-3">{s.heading}</h2>
            {s.body.map((p, i) => (
              <p key={i} className="text-muted-foreground leading-relaxed mb-3">{p}</p>
            ))}
          </section>
        ))}

        {/* Features */}
        {data.features.length > 0 && (
          <section className="mb-10">
            <h2 className="font-display font-bold text-2xl text-foreground mb-5">Key features</h2>
            <div className="grid sm:grid-cols-2 gap-4">
              {data.features.map((f) => (
                <div key={f.title} className="border border-border rounded-2xl p-5 bg-card">
                  <f.icon className="h-6 w-6 text-primary mb-3" />
                  <h3 className="font-semibold text-foreground mb-1">{f.title}</h3>
                  <p className="text-sm text-muted-foreground leading-relaxed">{f.desc}</p>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* How it works */}
        {data.steps.length > 0 && (
          <section className="mb-10">
            <h2 className="font-display font-bold text-2xl text-foreground mb-5">How it works</h2>
            <div className="space-y-3">
              {data.steps.map((s, i) => (
                <div key={s.title} className="flex gap-4 border border-border rounded-2xl p-4 bg-card">
                  <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-primary font-bold text-sm shrink-0">
                    {i + 1}
                  </div>
                  <div>
                    <h3 className="font-semibold text-foreground text-sm">{s.title}</h3>
                    <p className="text-sm text-muted-foreground">{s.desc}</p>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Comparison */}
        {data.comparison.length > 0 && (
          <section className="mb-10">
            <h2 className="font-display font-bold text-2xl text-foreground mb-5">Sale Point vs. the alternatives</h2>
            <div className="overflow-x-auto border border-border rounded-2xl">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-muted/50 text-left text-muted-foreground">
                    <th className="px-4 py-3 font-semibold">Comparison</th>
                    <th className="px-4 py-3 font-semibold text-primary">Sale Point</th>
                    <th className="px-4 py-3 font-semibold">Other options / manual book</th>
                  </tr>
                </thead>
                <tbody>
                  {data.comparison.map((row) => (
                    <tr key={row.feature} className="border-t border-border">
                      <td className="px-4 py-3 font-medium text-foreground">{row.feature}</td>
                      <td className="px-4 py-3">
                        <span className="inline-flex items-center gap-1.5 text-primary">
                          <Check className="h-4 w-4" /> {row.point}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">{row.other}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {/* FAQ */}
        {data.faqs.length > 0 && (
          <section className="mb-10">
            <h2 className="font-display font-bold text-2xl text-foreground mb-5">Frequently asked questions</h2>
            <Accordion type="single" collapsible className="w-full">
              {data.faqs.map((faq, i) => (
                <AccordionItem key={i} value={`faq-${i}`}>
                  <AccordionTrigger className="text-sm text-left">{faq.q}</AccordionTrigger>
                  <AccordionContent className="text-sm text-muted-foreground">{faq.a}</AccordionContent>
                </AccordionItem>
              ))}
            </Accordion>
          </section>
        )}

        {/* CTA */}
        <section className="rounded-3xl bg-primary p-8 text-center text-primary-foreground mb-10">
          <h2 className="font-display font-bold text-2xl mb-2">Ready to run your shop on Sale Point?</h2>
          <p className="text-primary-foreground/90 mb-6 max-w-md mx-auto">
            Start free today. No card required, no equipment to buy — use any phone or tablet.
          </p>
          <Link to="/auth?tab=register">
            <Button size="lg" variant="outline" className="bg-background">Start Free Trial</Button>
          </Link>
        </section>

        {/* Related */}
        {data.related.length > 0 && (
          <section className="mb-8">
            <h2 className="font-display font-bold text-xl text-foreground mb-4">Related guides</h2>
            <div className="flex flex-wrap gap-2">
              {data.related.map((r) => (
                <Link
                  key={r.path}
                  to={r.path}
                  className="text-sm font-medium bg-muted text-foreground hover:bg-primary hover:text-primary-foreground rounded-full px-4 py-2 transition"
                >
                  {r.label}
                </Link>
              ))}
            </div>
          </section>
        )}
      </main>

      {/* Footer */}
      <footer className="border-t py-6 text-center text-xs text-muted-foreground">
        <div className="max-w-4xl mx-auto px-4 flex flex-wrap items-center justify-center gap-x-4 gap-y-2 mb-3">
          <Link to="/" className="hover:text-primary">Home</Link>
          {data.related.map((r) => (
            <Link key={r.path} to={r.path} className="hover:text-primary">{r.label}</Link>
          ))}
        </div>
        <p>Product of MC Sale Point Solutions</p>
        <p>© {new Date().getFullYear()} Sale Point. Built for Zambian businesses.</p>
      </footer>
    </div>
  );
}