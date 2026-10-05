import { useEffect, useState, useCallback } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuthContext } from '@/contexts/AuthContext';
import { useBusiness } from '@/hooks/useBusiness';
import { useBusinessContext } from '@/hooks/BusinessContext';
import { useBusinessType } from '@/hooks/useBusinessType';
import { BranchSwitcher } from '@/components/BranchSwitcher';
import { usePushNotifications } from '@/hooks/usePushNotifications';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import LockScreen from '@/components/LockScreen';
import ConnectionStatus from '@/components/ConnectionStatus';
import NoticeBanner from '@/components/NoticeBanner';
import LowStockAlert from '@/components/LowStockAlert';
import DashboardNotifications from '@/components/DashboardNotifications';
import DashboardStats from '@/components/DashboardStats';

import { Store, ShoppingCart, Package, CreditCard, LogOut, Copy, Receipt, Settings as SettingsIcon, Users, Wallet, Briefcase, BarChart3, FileClock, UserCheck, CalendarClock, ChefHat, LayoutGrid, Building2, HardHat } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { supabase } from '@/integrations/supabase/client';

const Dashboard = () => {
  const navigate = useNavigate();
  const { user, signOut, isLoading: authLoading } = useAuthContext();
  const { business, isLoading: businessLoading, error: businessError, refetch, checkSubscriptionStatus } = useBusiness(user?.id);
  const { isMultiBranch } = useBusinessContext();
  const { labels, isService, isRestaurant } = useBusinessType(business?.id, business?.businessType);
  const { toast } = useToast();
  const [hasSalesToday, setHasSalesToday] = useState(false);
  const [expiringProducts, setExpiringProducts] = useState<Array<{ name: string; expiryDate: string }>>([]);

  const { isLocked, daysRemaining } = checkSubscriptionStatus();

  useEffect(() => {
    if (!authLoading && !user) {
      navigate('/auth');
    }
  }, [user, authLoading, navigate]);

  const checkHasSalesToday = useCallback(async () => {
    if (!business?.id) return;
    const today = new Date().toISOString().split('T')[0];
    supabase
      .from('sales')
      .select('id', { count: 'exact', head: true })
      .eq('business_id', business.id)
      .gte('created_at', `${today}T00:00:00`)
      .lte('created_at', `${today}T23:59:59`)
      .then(({ count }) => setHasSalesToday((count ?? 0) > 0))
      .catch(() => {});
  }, [business?.id]);

  useEffect(() => {
    checkHasSalesToday();
    const handler = () => checkHasSalesToday();
    window.addEventListener("zampos:sales-changed", handler);
    window.addEventListener("zampos:sync-complete", handler);
    return () => {
      window.removeEventListener("zampos:sales-changed", handler);
      window.removeEventListener("zampos:sync-complete", handler);
    };
  }, [checkHasSalesToday]);

  const checkExpiringProducts = useCallback(async () => {
    if (!business?.id || isService) return;
    const today = new Date().toISOString().split('T')[0];
    const future = new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0];
    supabase
      .from('products')
      .select('name, expiry_date')
      .eq('business_id', business.id)
      .eq('track_expiry', true)
      .gte('expiry_date', today)
      .lte('expiry_date', future)
      .order('expiry_date', { ascending: true })
      .limit(20)
      .then(({ data }) => {
        if (data) setExpiringProducts(data.map((r: any) => ({ name: r.name, expiryDate: r.expiry_date })));
      })
      .catch(() => {});
  }, [business?.id, isService]);

  useEffect(() => {
    checkExpiringProducts();
    window.addEventListener("zampos:sync-complete", checkExpiringProducts);
    return () => window.removeEventListener("zampos:sync-complete", checkExpiringProducts);
  }, [checkExpiringProducts]);

  usePushNotifications(
    daysRemaining,
    business?.subscriptionStatus || '',
    hasSalesToday,
    isService,
  );

  if (authLoading || businessLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-center">
          <Store className="w-12 h-12 text-primary mx-auto mb-4 animate-pulse" />
          <p className="text-muted-foreground">Loading...</p>
        </div>
      </div>
    );
  }

  const handleRetry = () => refetch();

  const handleSignOut = async () => {
    await signOut();
    navigate('/auth');
  };

  if (!business && businessError) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <div className="text-center max-w-md">
          <Store className="w-12 h-12 text-primary mx-auto mb-4" />
          <h2 className="font-display font-bold text-xl mb-2">Unable to load dashboard</h2>
          <p className="text-sm text-muted-foreground mb-4">
            {businessError}. Please make sure the database migrations have been applied.
          </p>
          <div className="flex gap-2 justify-center">
            <Button variant="outline" onClick={() => window.location.reload()}>
              Reload
            </Button>
            <Button variant="pos" onClick={handleRetry}>
              Retry
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (!business) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <div className="text-center max-w-md">
          <Store className="w-12 h-12 text-primary mx-auto mb-4" />
          <h2 className="font-display font-bold text-xl mb-2">No business found</h2>
          <p className="text-sm text-muted-foreground mb-4">
            This account is not linked to a business. New businesses are created
            automatically when you register, so if you just signed up, try signing
            out and signing back in. Admin/allowlisted accounts are not given a business.
          </p>
          <div className="flex gap-2 justify-center">
            <Button variant="outline" onClick={() => window.location.reload()}>
              Reload
            </Button>
            <Button variant="pos" onClick={handleSignOut}>
              Sign out
            </Button>
          </div>
        </div>
      </div>
    );
  }

  const copyPaymentCode = () => {
    navigator.clipboard.writeText(business.paymentCode);
    toast({ title: 'Copied!', description: 'Payment code copied' });
  };

  const getStatusBadge = () => {
    switch (business.subscriptionStatus) {
      case 'trial':
        return <Badge className="badge-trial">Trial - {daysRemaining} days left</Badge>;
      case 'active':
        return <Badge className="badge-active">Active - {daysRemaining} days left</Badge>;
      case 'expired':
        return <Badge className="badge-expired">Expired</Badge>;
      default:
        return <Badge className="badge-locked">Locked</Badge>;
    }
  };

  if (isLocked) {
    return (
      <>
        <ConnectionStatus />
        <LockScreen 
          paymentCode={business.paymentCode} 
          businessId={business.id}
          onRetrySync={refetch}
        />
      </>
    );
  }

  return (
    <>
      <ConnectionStatus />
      <div className="min-h-screen bg-background safe-area-inset">
        {/* Header */}
        <header className="bg-card border-b border-border px-4 py-4">
          <div className="flex items-center justify-between gap-2 flex-wrap max-w-4xl mx-auto">
            <div className="flex items-center gap-3 min-w-0 flex-1">
              <div className="w-10 h-10 rounded-xl bg-primary flex items-center justify-center shrink-0">
                <Store className="w-5 h-5 text-primary-foreground" />
              </div>
              <div className="min-w-0">
                <h1 className="font-display font-bold text-lg truncate">{business.name}</h1>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">{business.paymentCode}</span>
                  <button onClick={copyPaymentCode}><Copy className="w-3 h-3 text-muted-foreground" /></button>
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0 flex-wrap justify-end">
              <BranchSwitcher />
              {getStatusBadge()}
            </div>
          </div>
        </header>

        {/* Main Content */}
        <main className="p-4 max-w-4xl mx-auto space-y-4">
          {/* Notices */}
          <NoticeBanner businessId={business.id} />

          {/* Quick Stats */}
          <DashboardStats businessId={business.id} isService={isService} />

          {/* Low Stock Alerts - only for retail businesses */}
          {!isService && <LowStockAlert businessId={business.id} />}

          {/* Expiring Soon - only for retail businesses */}
          {!isService && expiringProducts.length > 0 && (
            <Card className="border-amber-300 dark:border-amber-700">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2 text-amber-700 dark:text-amber-400">
                  <CalendarClock className="w-4 h-4" />
                  Expiring Soon
                </CardTitle>
                <CardDescription className="text-xs">
                  {expiringProducts.length} product{expiringProducts.length > 1 ? 's' : ''} expiring within 30 days
                </CardDescription>
              </CardHeader>
              <CardContent>
                <ul className="divide-y divide-border text-sm">
                  {expiringProducts.slice(0, 10).map((p, i) => {
                    const daysLeft = Math.ceil((new Date(p.expiryDate).getTime() - Date.now()) / 86400000);
                    return (
                      <li key={i} className="flex justify-between py-1.5">
                        <span className="truncate mr-2">{p.name}</span>
                        <span className={`font-mono shrink-0 ${daysLeft <= 7 ? 'text-destructive font-semibold' : 'text-muted-foreground'}`}>
                          {daysLeft <= 0 ? 'Expired' : `${daysLeft}d`}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </CardContent>
            </Card>
          )}

          {/* Dashboard Notifications */}
          <DashboardNotifications
            businessId={business.id}
            daysRemaining={daysRemaining}
            subscriptionStatus={business.subscriptionStatus}
            isService={isService}
          />

          {/* Quick Actions */}
          <div className="grid grid-cols-2 gap-4">
            <Link to="/pos">
              <Card className="product-card h-full">
                <CardContent className="flex flex-col items-center justify-center p-6 text-center">
                  <div className="w-14 h-14 rounded-2xl bg-primary/10 flex items-center justify-center mb-3">
                    <ShoppingCart className="w-7 h-7 text-primary" />
                  </div>
                  <h3 className="font-semibold">New Sale</h3>
                  <p className="text-sm text-muted-foreground">Start selling</p>
                </CardContent>
              </Card>
            </Link>

            <Link to="/products">
              <Card className="product-card h-full">
                <CardContent className="flex flex-col items-center justify-center p-6 text-center">
                  <div className="w-14 h-14 rounded-2xl bg-accent/10 flex items-center justify-center mb-3">
                    {isService ? <Briefcase className="w-7 h-7 text-accent" /> : <Package className="w-7 h-7 text-accent" />}
                  </div>
                  <h3 className="font-semibold">{labels.productsTitle}</h3>
                  <p className="text-sm text-muted-foreground">{isService ? 'Manage services' : 'Manage stock'}</p>
                </CardContent>
              </Card>
            </Link>

            <Link to="/sales">
              <Card className="product-card h-full">
                <CardContent className="flex flex-col items-center justify-center p-6 text-center">
                  <div className="w-14 h-14 rounded-2xl bg-secondary flex items-center justify-center mb-3">
                    <Receipt className="w-7 h-7 text-foreground" />
                  </div>
                  <h3 className="font-semibold">Sales & Reports</h3>
                  <p className="text-sm text-muted-foreground">Sales, expenses, profit</p>
                </CardContent>
              </Card>
            </Link>

            <Link to="/debtors">
              <Card className="product-card h-full">
                <CardContent className="flex flex-col items-center justify-center p-6 text-center">
                  <div className="w-14 h-14 rounded-2xl bg-amber-500/10 flex items-center justify-center mb-3">
                    <Users className="w-7 h-7 text-amber-600" />
                  </div>
                  <h3 className="font-semibold">Debtors</h3>
                  <p className="text-sm text-muted-foreground">Credit sales</p>
                </CardContent>
              </Card>
            </Link>

            {isRestaurant && (
              <Link to="/tables">
                <Card className="product-card h-full">
                  <CardContent className="flex flex-col items-center justify-center p-6 text-center">
                    <div className="w-14 h-14 rounded-2xl bg-primary/10 flex items-center justify-center mb-3">
                      <LayoutGrid className="w-7 h-7 text-primary" />
                    </div>
                    <h3 className="font-semibold">Floor Plan</h3>
                    <p className="text-sm text-muted-foreground">Tables & orders</p>
                  </CardContent>
                </Card>
              </Link>
            )}
          </div>

          {/* Secondary Actions */}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <Link to="/reports">
              <Card className="product-card h-full">
                <CardContent className="flex flex-col items-center justify-center p-4 text-center">
                  <BarChart3 className="w-6 h-6 text-primary mb-2" />
                  <h3 className="font-medium text-sm">Reports</h3>
                  <p className="text-xs text-muted-foreground">Sales & profit</p>
                </CardContent>
              </Card>
            </Link>
            {business?.capexEnabled && (
              <Link to="/capex">
                <Card className="product-card h-full">
                  <CardContent className="flex flex-col items-center justify-center p-4 text-center">
                    <HardHat className="w-6 h-6 text-primary mb-2" />
                    <h3 className="font-medium text-sm">CAPEX</h3>
                    <p className="text-xs text-muted-foreground">Capital purchases</p>
                  </CardContent>
                </Card>
              </Link>
            )}
            {isRestaurant && (
              <Link to="/kitchen">
                <Card className="product-card h-full">
                  <CardContent className="flex flex-col items-center justify-center p-4 text-center">
                    <ChefHat className="w-6 h-6 text-muted-foreground mb-2" />
                    <h3 className="font-medium text-sm">Kitchen</h3>
                    <p className="text-xs text-muted-foreground">Order tickets</p>
                  </CardContent>
                </Card>
              </Link>
            )}
            <Link to="/cashier-activity">
              <Card className="product-card h-full">
                <CardContent className="flex flex-col items-center justify-center p-4 text-center">
                  <UserCheck className="w-6 h-6 text-primary mb-2" />
                  <h3 className="font-medium text-sm">Cashiers</h3>
                  <p className="text-xs text-muted-foreground">Activity today</p>
                </CardContent>
              </Card>
            </Link>
            {isMultiBranch && (
              <Link to="/branches">
                <Card className="product-card h-full">
                  <CardContent className="flex flex-col items-center justify-center p-4 text-center">
                    <Building2 className="w-6 h-6 text-primary mb-2" />
                    <h3 className="font-medium text-sm">All Branches</h3>
                    <p className="text-xs text-muted-foreground">Group overview</p>
                  </CardContent>
                </Card>
              </Link>
            )}
            <Link to="/audit-log">
              <Card className="product-card h-full">
                <CardContent className="flex flex-col items-center justify-center p-4 text-center">
                  <FileClock className="w-6 h-6 text-muted-foreground mb-2" />
                  <h3 className="font-medium text-sm">Audit Log</h3>
                  <p className="text-xs text-muted-foreground">All changes</p>
                </CardContent>
              </Card>
            </Link>
            <Link to="/subscription">
              <Card className="product-card h-full">
                <CardContent className="flex flex-col items-center justify-center p-4 text-center">
                  <CreditCard className="w-6 h-6 text-muted-foreground mb-2" />
                  <h3 className="font-medium text-sm">Subscription</h3>
                  <p className="text-xs text-muted-foreground">{daysRemaining} days left</p>
                </CardContent>
              </Card>
            </Link>
            <Link to="/affiliate">
              <Card className="product-card h-full">
                <CardContent className="flex flex-col items-center justify-center p-4 text-center">
                  <Wallet className="w-6 h-6 text-muted-foreground mb-2" />
                  <h3 className="font-medium text-sm">Affiliate</h3>
                  <p className="text-xs text-muted-foreground">Earn referrals</p>
                </CardContent>
              </Card>
            </Link>
            <Link to="/settings">
              <Card className="product-card h-full">
                <CardContent className="flex flex-col items-center justify-center p-4 text-center">
                  <SettingsIcon className="w-6 h-6 text-muted-foreground mb-2" />
                  <h3 className="font-medium text-sm">Settings</h3>
                  <p className="text-xs text-muted-foreground">Profile</p>
                </CardContent>
              </Card>
            </Link>
          </div>

          {/* Sign Out */}
          <Button variant="ghost" className="w-full" onClick={handleSignOut}>
            <LogOut className="w-4 h-4 mr-2" />
            Sign Out
          </Button>
        </main>
      </div>
    </>
  );
};

export default Dashboard;
