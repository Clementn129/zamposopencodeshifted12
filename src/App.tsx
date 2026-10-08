import { forwardRef, lazy, Suspense, useEffect } from "react";
import { Loader2 } from "lucide-react";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, useLocation } from "react-router-dom";
import { AuthProvider } from "@/contexts/AuthContext";
import { BusinessProvider } from "@/hooks/BusinessContext";
import RequireOwner from "@/components/RequireOwner";
import RequireKitchen from "@/components/RequireKitchen";
import RequireMember from "@/components/RequireMember";
import ErrorBoundary from "@/components/ErrorBoundary";
import { PWAUpdatePrompt } from "@/components/PWAUpdatePrompt";
import { AppSyncManager } from "@/components/AppSyncManager";
import { AuthLinkHandler } from "@/components/AuthLinkHandler";
import { seoRoutes, SEO_PATHS } from "./pages/seo/routes";
import { SITE_URL, DEFAULT_TITLE, DEFAULT_DESCRIPTION } from "@/lib/seoDefaults";

// Lightweight public pages load eagerly for a fast first paint (landing, auth).
import Index from "./pages/Index";
import Auth from "./pages/Auth";
import AdminLogin from "./pages/AdminLogin";
import PrivacyPolicy from "./pages/PrivacyPolicy";

// Heavier app pages load on demand to keep the initial bundle small.
const AdminDashboard = lazy(() => import("./pages/AdminDashboard"));
const Dashboard = lazy(() => import("./pages/Dashboard"));
const Pos = lazy(() => import("./pages/Pos"));
const Products = lazy(() => import("./pages/Products"));
const Subscription = lazy(() => import("./pages/Subscription"));
const SalesHistory = lazy(() => import("./pages/SalesHistory"));
const Settings = lazy(() => import("./pages/Settings"));
const Debtors = lazy(() => import("./pages/Debtors"));
const Affiliate = lazy(() => import("./pages/Affiliate"));
const AffiliateAuth = lazy(() => import("./pages/AffiliateAuth"));
const Capex = lazy(() => import("./pages/Capex"));
const StockRequests = lazy(() => import("./pages/StockRequests"));
const Reports = lazy(() => import("./pages/Reports"));
const CashierActivity = lazy(() => import("./pages/CashierActivity"));
const AuditLog = lazy(() => import("./pages/AuditLog"));
const GroupOverview = lazy(() => import("./pages/GroupOverview").then((m) => ({ default: m.GroupOverview })));
const Kitchen = lazy(() => import("./pages/Kitchen"));
const DiningTabs = lazy(() => import("./pages/DiningTabs"));
const NotFound = lazy(() => import("./pages/NotFound"));

const queryClient = new QueryClient();

function PageFallback() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
    </div>
  );
}

// Restores the default page title/description/canonical when leaving an SEO page.
function SeoReset() {
  const location = useLocation();
  useEffect(() => {
    if (SEO_PATHS.includes(location.pathname)) return;
    document.title = DEFAULT_TITLE;
    const setMeta = (name: string, content: string) => {
      const el = document.head.querySelector<HTMLMetaElement>(`meta[name="${name}"]`);
      if (el) el.setAttribute("content", content);
    };
    setMeta("description", DEFAULT_DESCRIPTION);
    setMeta("twitter:description", DEFAULT_DESCRIPTION);
    const canonical = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    if (canonical) canonical.setAttribute("href", `${SITE_URL}/`);
    const jsonLd = document.getElementById("seo-jsonld");
    if (jsonLd) jsonLd.remove();
  }, [location.pathname]);
  return null;
}

const App = forwardRef<HTMLDivElement>((_, ref) => (
  <div ref={ref}>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <TooltipProvider>
            <Toaster />
            <Sonner />
            <PWAUpdatePrompt />
            <BusinessProvider>
              <AppSyncManager>
                <BrowserRouter>
                  <SeoReset />
                  <AuthLinkHandler />
                  <Suspense fallback={<PageFallback />}>
                    <Routes>
                      <Route path="/" element={<Index />} />
                      <Route path="/auth" element={<Auth />} />
                      <Route path="/privacy-policy" element={<PrivacyPolicy />} />
                      <Route path="/admin/login" element={<AdminLogin />} />
                      <Route path="/admin-login" element={<AdminLogin />} />
                      <Route path="/admin" element={<AdminDashboard />} />
                      <Route path="/dashboard" element={<RequireOwner><Dashboard /></RequireOwner>} />
                      <Route path="/pos" element={<Pos />} />
                      <Route path="/kitchen" element={<RequireKitchen><Kitchen /></RequireKitchen>} />
                      <Route path="/tables" element={<RequireMember restaurantOnly><DiningTabs /></RequireMember>} />
                      <Route path="/products" element={<RequireOwner allowManager><Products /></RequireOwner>} />
                      <Route path="/stock" element={<StockRequests />} />
                      <Route path="/subscription" element={<RequireOwner><Subscription /></RequireOwner>} />
                      <Route path="/sales" element={<RequireOwner><SalesHistory /></RequireOwner>} />
                      <Route path="/reports" element={<RequireOwner><Reports /></RequireOwner>} />
                      <Route path="/capex" element={<RequireOwner><Capex /></RequireOwner>} />
                      <Route path="/branches" element={<RequireOwner><GroupOverview /></RequireOwner>} />
                      <Route path="/cashier-activity" element={<RequireOwner><CashierActivity /></RequireOwner>} />
                      <Route path="/audit-log" element={<RequireOwner><AuditLog /></RequireOwner>} />
                      <Route path="/debtors" element={<RequireOwner><Debtors /></RequireOwner>} />
                      <Route path="/settings" element={<RequireOwner><Settings /></RequireOwner>} />
                      <Route path="/affiliate" element={<RequireOwner><Affiliate /></RequireOwner>} />
                      <Route path="/affiliate-auth" element={<AffiliateAuth />} />
                      {seoRoutes.map((r) => (
                        <Route key={r.path} path={r.path} element={<r.Component />} />
                      ))}
                      <Route path="*" element={<NotFound />} />
                    </Routes>
                  </Suspense>
                </BrowserRouter>
              </AppSyncManager>
            </BusinessProvider>
          </TooltipProvider>
        </AuthProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  </div>
));

App.displayName = "App";

export default App;
