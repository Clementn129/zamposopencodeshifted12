import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Activity, BarChart3, Bell, Building2, Calendar, CalendarMinus, CheckCircle2, CreditCard, DollarSign, Download, LogOut, Phone, Mail, MapPin, Plus, Power, PowerOff, Settings as SettingsIcon, Shield, TrendingUp, Trash2, Users, Wallet, Wifi, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import ConnectionStatus from "@/components/ConnectionStatus";
import AdminAffiliatePanel from "@/components/AdminAffiliatePanel";
import { useAuthContext } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { clearOfflineSession } from "@/lib/offlineStorage";
import { PAYMENT_DETAILS, PRICING_TIERS } from "@/lib/paymentDetails";
import { exportBusinessesToCsv } from "@/lib/csvExport";
import { useToast } from "@/hooks/use-toast";

type BusinessRow = {
  id: string;
  name: string;
  user_id: string;
  payment_code: string;
  subscription_status: "trial" | "active" | "expired" | "locked";
  subscription_expires_at: string | null;
  is_locked: boolean;
  last_sync_at: string;
  created_at: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  plan_tier: string | null;
};


type PaymentRow = {
  id: string;
  business_id: string;
  amount: number;
  status: "pending" | "approved" | "rejected";
  notes: string | null;
  created_at: string;
};

type NoticeRow = {
  id: string;
  title: string;
  message: string;
  is_active: boolean;
  starts_at: string;
  ends_at: string | null;
  created_at: string;
  target_business_id?: string | null;
};

type ProfileRow = {
  user_id: string;
  full_name: string | null;
  email: string | null;
};

// Target type for notices
type NoticeTarget = 'all' | string; // 'all' or business_id

const AdminDashboard = () => {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { user, isLoading: authLoading, isSuperAdmin, role } = useAuthContext();

  const [businesses, setBusinesses] = useState<BusinessRow[]>([]);
  const [payments, setPayments] = useState<PaymentRow[]>([]);
  const [notices, setNotices] = useState<NoticeRow[]>([]);
  const [profiles, setProfiles] = useState<ProfileRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [adminChecked, setAdminChecked] = useState(false);
  const [roleTimeout, setRoleTimeout] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setRoleTimeout(true), 5000);
    return () => clearTimeout(t);
  }, []);

  // Subscription extension state
  const [extendAmount, setExtendAmount] = useState<Record<string, number>>({});
  const [extendUnit, setExtendUnit] = useState<Record<string, 'days' | 'weeks' | 'months'>>({});

  // Notice form state
  const [noticeTitle, setNoticeTitle] = useState("");
  const [noticeMessage, setNoticeMessage] = useState("");
  const [noticeEndsIn, setNoticeEndsIn] = useState<string>("7");
  const [noticeTarget, setNoticeTarget] = useState<NoticeTarget>("all");
  const [noticeDialogOpen, setNoticeDialogOpen] = useState(false);

  useEffect(() => {
    if (authLoading) return;
    if (!user) { navigate("/admin-login"); return; }
    // Wait until role is resolved before deciding access
    if (role === 'unknown' && !roleTimeout) return;
    setAdminChecked(true);
    if (!isSuperAdmin) navigate("/admin-login");
  }, [authLoading, user, role, isSuperAdmin, roleTimeout, navigate]);

  const refresh = async () => {
    setLoading(true);
    try {
      const { data: biz, error: bizErr } = await supabase
        .from("businesses")
        .select("id,name,user_id,payment_code,subscription_status,subscription_expires_at,is_locked,last_sync_at,created_at,phone,email,address,plan_tier")
        .order("created_at", { ascending: false })
        .limit(200);
      if (bizErr) throw bizErr;
      setBusinesses((biz ?? []) as BusinessRow[]);

      const { data: pay, error: payErr } = await supabase
        .from("payments")
        .select("id,business_id,amount,status,notes,created_at")
        .order("created_at", { ascending: false })
        .limit(200);
      if (payErr) throw payErr;
      setPayments((pay ?? []) as PaymentRow[]);

      const { data: not, error: notErr } = await supabase
        .from("notices")
        .select("id,title,message,is_active,starts_at,ends_at,created_at,target_business_id")
        .order("created_at", { ascending: false })
        .limit(100);
      if (notErr) throw notErr;
      setNotices((not ?? []) as NoticeRow[]);

      const { data: prof, error: profErr } = await supabase
        .from("profiles")
        .select("user_id,full_name,email")
        .limit(500);
      if (profErr) throw profErr;
      setProfiles((prof ?? []) as ProfileRow[]);
    } catch (e: any) {
      toast({ variant: "destructive", title: "Failed", description: e?.message ?? "Could not load admin data" });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (user && isSuperAdmin) {
      refresh();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, isSuperAdmin]);

  const approve = async (p: PaymentRow) => {
    if (!user) return;

    try {
      const { error: updPayErr } = await supabase
        .from("payments")
        .update({ status: "approved", approved_at: new Date().toISOString(), approved_by: user.id })
        .eq("id", p.id);
      if (updPayErr) throw updPayErr;

      const months = Math.max(1, Math.round(Number(p.amount) / PAYMENT_DETAILS.pricePerMonthZmw));
      const extendDays = months * 30;

      const biz = businesses.find((b) => b.id === p.business_id);
      const base = biz?.subscription_expires_at ? new Date(biz.subscription_expires_at) : new Date();
      const start = base.getTime() > Date.now() ? base : new Date();
      const newExpires = new Date(start.getTime() + extendDays * 24 * 60 * 60 * 1000).toISOString();

      const { error: updBizErr } = await supabase
        .from("businesses")
        .update({
          subscription_status: "active",
          subscription_expires_at: newExpires,
          is_locked: false,
          updated_at: new Date().toISOString(),
        })
        .eq("id", p.business_id);
      if (updBizErr) throw updBizErr;

      toast({ title: "Approved", description: `Extended by ${extendDays} days.` });
      await refresh();
    } catch (e: any) {
      toast({ variant: "destructive", title: "Failed", description: e?.message ?? "Could not approve" });
    }
  };

  const reject = async (p: PaymentRow) => {
    if (!user) return;
    try {
      const { error } = await supabase
        .from("payments")
        .update({ status: "rejected", approved_at: new Date().toISOString(), approved_by: user.id })
        .eq("id", p.id);
      if (error) throw error;
      toast({ title: "Rejected" });
      await refresh();
    } catch (e: any) {
      toast({ variant: "destructive", title: "Failed", description: e?.message ?? "Could not reject" });
    }
  };

  const toggleLock = async (b: BusinessRow) => {
    try {
      const newLocked = !b.is_locked;
      const newStatus = newLocked ? "locked" : (b.subscription_status === "locked" ? "expired" : b.subscription_status);
      
      const { error } = await supabase
        .from("businesses")
        .update({ 
          is_locked: newLocked, 
          subscription_status: newStatus,
          updated_at: new Date().toISOString() 
        })
        .eq("id", b.id);
      
      if (error) throw error;
      toast({ title: newLocked ? "Business Locked" : "Business Unlocked" });
      await refresh();
    } catch (e: any) {
      toast({ variant: "destructive", title: "Failed", description: e?.message ?? "Could not update" });
    }
  };

  const getExtendDays = (businessId: string) => {
    const amount = extendAmount[businessId] || 1;
    const unit = extendUnit[businessId] || 'months';
    switch (unit) {
      case 'days': return amount;
      case 'weeks': return amount * 7;
      case 'months': return amount * 30;
      default: return amount * 30;
    }
  };

  const extendSubscription = async (b: BusinessRow) => {
    const extendDays = getExtendDays(b.id);

    try {
      const base = b.subscription_expires_at ? new Date(b.subscription_expires_at) : new Date();
      const start = base.getTime() > Date.now() ? base : new Date();
      const newExpires = new Date(start.getTime() + extendDays * 24 * 60 * 60 * 1000).toISOString();

      const { error } = await supabase
        .from("businesses")
        .update({
          subscription_status: "active",
          subscription_expires_at: newExpires,
          is_locked: false,
          updated_at: new Date().toISOString(),
        })
        .eq("id", b.id);

      if (error) throw error;
      toast({ title: "Subscription Extended", description: `Extended by ${extendDays} days.` });
      setExtendAmount((prev) => ({ ...prev, [b.id]: 1 }));
      setExtendUnit((prev) => ({ ...prev, [b.id]: 'months' }));
      await refresh();
    } catch (e: any) {
      toast({ variant: "destructive", title: "Failed", description: e?.message ?? "Could not extend" });
    }
  };

  const unextendSubscription = async (b: BusinessRow) => {
    const reduceDays = getExtendDays(b.id);

    try {
      if (!b.subscription_expires_at) {
        toast({ variant: "destructive", title: "Error", description: "No expiration date set" });
        return;
      }

      const current = new Date(b.subscription_expires_at);
      const newExpires = new Date(current.getTime() - reduceDays * 24 * 60 * 60 * 1000);
      
      // Check if new date is in the past
      const now = new Date();
      const newStatus = newExpires < now ? "expired" : "active";

      const { error } = await supabase
        .from("businesses")
        .update({
          subscription_status: newStatus,
          subscription_expires_at: newExpires.toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", b.id);

      if (error) throw error;
      toast({ title: "Subscription Reduced", description: `Reduced by ${reduceDays} days.` });
      setExtendAmount((prev) => ({ ...prev, [b.id]: 1 }));
      setExtendUnit((prev) => ({ ...prev, [b.id]: 'months' }));
      await refresh();
    } catch (e: any) {
      toast({ variant: "destructive", title: "Failed", description: e?.message ?? "Could not reduce" });
    }
  };

  const deleteBusiness = async (b: BusinessRow) => {
    if (!confirm(`Are you sure you want to delete "${b.name}"? This will permanently remove all their data including sales, products, and payment history. This cannot be undone!`)) {
      return;
    }

    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData?.session?.access_token;
      if (!token) throw new Error("Not authenticated");

      const res = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/admin-delete-business`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ business_id: b.id }),
        }
      );

      const result = await res.json();
      if (!res.ok) throw new Error(result.error || "Could not delete business");

      toast({ title: "Business Deleted", description: `${b.name} has been permanently deleted.` });
      await refresh();
    } catch (e: any) {
      toast({ variant: "destructive", title: "Failed", description: e?.message ?? "Could not delete business" });
    }
  };

  const setPlan = async (b: BusinessRow, planLabel: string) => {
    try {
      const value = planLabel === "auto" ? null : planLabel;
      const { error } = await supabase
        .from("businesses")
        .update({ plan_tier: value, updated_at: new Date().toISOString() })
        .eq("id", b.id);
      if (error) throw error;
      toast({ title: "Plan updated", description: value ? `Set to ${value}.` : "Reverted to automatic (based on cashier count)." });
      await refresh();
    } catch (e: any) {
      toast({ variant: "destructive", title: "Failed", description: e?.message ?? "Could not update plan" });
    }
  };


  const handleExportCsv = () => {
    exportBusinessesToCsv(businesses, 'salepoint-businesses');
    toast({ title: 'Exported', description: 'Businesses data downloaded as CSV' });
  };

  const createNotice = async () => {
    if (!user || !noticeTitle.trim() || !noticeMessage.trim()) {
      toast({ variant: "destructive", title: "Error", description: "Please fill in all fields" });
      return;
    }

    try {
      const endsAt = noticeEndsIn === "never" 
        ? null 
        : new Date(Date.now() + parseInt(noticeEndsIn) * 24 * 60 * 60 * 1000).toISOString();

      const insertData: any = {
        title: noticeTitle.trim(),
        message: noticeMessage.trim(),
        starts_at: new Date().toISOString(),
        ends_at: endsAt,
        created_by: user.id,
        is_active: true,
      };

      // If targeting specific business, add target_business_id
      if (noticeTarget !== 'all') {
        insertData.target_business_id = noticeTarget;
      }

      const { error } = await supabase
        .from("notices")
        .insert(insertData);

      if (error) throw error;
      toast({ title: "Notice Created" });
      setNoticeTitle("");
      setNoticeMessage("");
      setNoticeEndsIn("7");
      setNoticeTarget("all");
      setNoticeDialogOpen(false);
      await refresh();
    } catch (e: any) {
      toast({ variant: "destructive", title: "Failed", description: e?.message ?? "Could not create notice" });
    }
  };

  const toggleNotice = async (n: NoticeRow) => {
    try {
      const { error } = await supabase
        .from("notices")
        .update({ is_active: !n.is_active, updated_at: new Date().toISOString() })
        .eq("id", n.id);

      if (error) throw error;
      toast({ title: n.is_active ? "Notice Deactivated" : "Notice Activated" });
      await refresh();
    } catch (e: any) {
      toast({ variant: "destructive", title: "Failed", description: e?.message ?? "Could not update" });
    }
  };

  const deleteNotice = async (n: NoticeRow) => {
    try {
      const { error } = await supabase
        .from("notices")
        .delete()
        .eq("id", n.id);

      if (error) throw error;
      toast({ title: "Notice Deleted" });
      await refresh();
    } catch (e: any) {
      toast({ variant: "destructive", title: "Failed", description: e?.message ?? "Could not delete" });
    }
  };

  const handleLogout = async () => {
    clearOfflineSession();
    await supabase.auth.signOut();
    navigate("/admin-login");
  };

  const getProfile = (userId: string) => profiles.find((p) => p.user_id === userId);

  const statusBadge = (s: BusinessRow["subscription_status"], locked: boolean) => {
    if (locked) return <Badge className="bg-red-500/20 text-red-700 dark:text-red-400 border-red-500/30">Locked</Badge>;
    if (s === "trial") return <Badge className="bg-blue-500/20 text-blue-700 dark:text-blue-400 border-blue-500/30">Trial</Badge>;
    if (s === "active") return <Badge className="bg-green-500/20 text-green-700 dark:text-green-400 border-green-500/30">Active</Badge>;
    if (s === "expired") return <Badge className="bg-orange-500/20 text-orange-700 dark:text-orange-400 border-orange-500/30">Expired</Badge>;
    return <Badge className="bg-red-500/20 text-red-700 dark:text-red-400 border-red-500/30">Locked</Badge>;
  };

  const formatLastSync = (dateStr: string) => {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffMins < 1) return "Just now";
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString();
  };

  const pendingPayments = useMemo(() => payments.filter((p) => p.status === "pending"), [payments]);

  const stats = useMemo(() => {
    const now = Date.now();
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);

    const active = businesses.filter((b) => !b.is_locked && b.subscription_status === "active").length;
    const trial = businesses.filter((b) => !b.is_locked && b.subscription_status === "trial").length;
    const expiredLocked = businesses.filter(
      (b) => b.is_locked || b.subscription_status === "expired" || b.subscription_status === "locked"
    ).length;

    const monthlyApproved = payments.filter(
      (p) => p.status === "approved" && new Date(p.created_at).getTime() >= monthStart.getTime()
    );
    const monthlyRevenue = monthlyApproved.reduce((sum, p) => sum + Number(p.amount || 0), 0);

    const expectedRevenue = active * PAYMENT_DETAILS.pricePerMonthZmw;
    const collectionRate = expectedRevenue > 0 ? Math.round((monthlyRevenue / expectedRevenue) * 100) : 0;

    return {
      total: businesses.length,
      active,
      trial,
      expiredLocked,
      monthlyRevenue,
      monthlyCount: monthlyApproved.length,
      collectionRate,
    };
  }, [businesses, payments]);


  if (authLoading || !adminChecked || (isSuperAdmin && loading)) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <p className="text-muted-foreground">Loading…</p>
      </div>
    );
  }

  if (!isSuperAdmin) {
    return null;
  }

  return (
    <>
      <ConnectionStatus />
      <div className="min-h-screen bg-background safe-area-inset">
        <header className="bg-card border-b border-border px-3 py-3 sm:px-4 sm:py-4">
          <div className="max-w-6xl mx-auto flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-2 sm:gap-3 min-w-0">
              <div className="w-9 h-9 sm:w-10 sm:h-10 rounded-xl bg-primary flex items-center justify-center shrink-0">
                <Shield className="w-5 h-5 text-primary-foreground" />
              </div>
              <div className="min-w-0">
                <h1 className="font-display font-bold text-base sm:text-lg truncate">Admin Dashboard</h1>
                <p className="text-[10px] sm:text-xs text-muted-foreground truncate">Businesses, subscriptions & payments</p>
              </div>
            </div>
            <div className="flex items-center gap-1.5 sm:gap-2 flex-wrap">
              <Button variant="outline" size="sm" onClick={handleExportCsv} className="h-8 px-2 sm:px-3">
                <Download className="h-4 w-4 sm:mr-2" />
                <span className="hidden sm:inline">Export CSV</span>
              </Button>
              <Button variant="outline" size="sm" onClick={refresh} className="h-8 px-2 sm:px-3">
                Refresh
              </Button>
              <Button variant="destructive" size="sm" onClick={handleLogout} className="h-8 px-2 sm:px-3">
                <LogOut className="h-4 w-4 sm:mr-2" />
                <span className="hidden sm:inline">Logout</span>
              </Button>
            </div>
          </div>
        </header>

        <main className="p-4 max-w-6xl mx-auto space-y-4">
          <Tabs defaultValue="stats" className="w-full">
            <TabsList className="grid w-full grid-cols-3 md:grid-cols-6 mb-4 h-auto bg-secondary/40 p-1 rounded-xl">
              <TabsTrigger value="stats" className="flex items-center gap-2 data-[state=active]:bg-background">
                <BarChart3 className="h-4 w-4" /> <span className="hidden sm:inline">Stats</span>
              </TabsTrigger>
              <TabsTrigger value="businesses" className="flex items-center gap-2 data-[state=active]:bg-background">
                <Building2 className="h-4 w-4" /> <span className="hidden sm:inline">Businesses</span>
              </TabsTrigger>
              <TabsTrigger value="subscriptions" className="flex items-center gap-2 data-[state=active]:bg-background">
                <CreditCard className="h-4 w-4" /> <span className="hidden sm:inline">Subscriptions</span>
              </TabsTrigger>
              <TabsTrigger value="payouts" className="flex items-center gap-2 data-[state=active]:bg-background">
                <Wallet className="h-4 w-4" /> <span className="hidden sm:inline">Payouts</span>
              </TabsTrigger>
              <TabsTrigger value="affiliates" className="flex items-center gap-2 data-[state=active]:bg-background">
                <Users className="h-4 w-4" /> <span className="hidden sm:inline">Affiliates</span>
              </TabsTrigger>
              <TabsTrigger value="settings" className="flex items-center gap-2 data-[state=active]:bg-background">
                <SettingsIcon className="h-4 w-4" /> <span className="hidden sm:inline">Settings</span>
              </TabsTrigger>
            </TabsList>

            <TabsContent value="stats" className="space-y-4">
              {/* KPI Cards */}
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                {[
                  { label: "Businesses Registered", value: stats.total, icon: Building2, tint: "bg-blue-500/10 text-blue-500" },
                  { label: "Active Subscriptions", value: stats.active, icon: Users, tint: "bg-emerald-500/10 text-emerald-500" },
                  { label: "Monthly Revenue", value: `K${stats.monthlyRevenue.toFixed(2)}`, icon: DollarSign, tint: "bg-purple-500/10 text-purple-500" },
                  { label: "Platform Status", value: "Online", icon: Wifi, tint: "bg-emerald-500/10 text-emerald-500", dot: true },
                ].map((kpi) => (
                  <Card key={kpi.label} className="border-border/60">
                    <CardContent className="p-4 flex items-start gap-3">
                      <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${kpi.tint}`}>
                        <kpi.icon className="h-5 w-5" />
                      </div>
                      <div className="min-w-0">
                        <p className="text-xs text-muted-foreground">{kpi.label}</p>
                        <p className="text-lg font-bold flex items-center gap-2">
                          {kpi.dot && <span className="w-2 h-2 rounded-full bg-emerald-500 inline-block" />}
                          {kpi.value}
                        </p>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>

              {/* Subscription Overview */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Activity className="h-4 w-4" /> Subscription Overview
                  </CardTitle>
                </CardHeader>
                <CardContent className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-4 text-center">
                    <p className="text-xs text-muted-foreground">Active</p>
                    <p className="text-2xl font-bold text-emerald-500">{stats.active}</p>
                  </div>
                  <div className="rounded-xl border border-blue-500/30 bg-blue-500/5 p-4 text-center">
                    <p className="text-xs text-muted-foreground">Trial / Free</p>
                    <p className="text-2xl font-bold text-blue-500">{stats.trial}</p>
                  </div>
                  <div className="rounded-xl border border-red-500/30 bg-red-500/5 p-4 text-center">
                    <p className="text-xs text-muted-foreground">Expired / Locked</p>
                    <p className="text-2xl font-bold text-red-500">{stats.expiredLocked}</p>
                  </div>
                </CardContent>
              </Card>

              {/* Revenue Overview */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base flex items-center gap-2">
                    <TrendingUp className="h-4 w-4" /> Revenue Overview
                  </CardTitle>
                  <CardDescription>
                    Revenue from approved payments this month
                  </CardDescription>
                </CardHeader>
                <CardContent className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div className="rounded-xl border border-border/60 p-4">
                    <p className="text-xs text-muted-foreground">Current Monthly Revenue</p>
                    <p className="text-2xl font-bold">K{stats.monthlyRevenue.toFixed(2)}</p>
                    <p className="text-xs text-muted-foreground mt-1">{stats.monthlyCount} payments this period</p>
                  </div>
                  <div className="rounded-xl border border-border/60 p-4">
                    <p className="text-xs text-muted-foreground">Expected Monthly Revenue</p>
                    <p className="text-2xl font-bold">K{(stats.active * PAYMENT_DETAILS.pricePerMonthZmw).toFixed(2)}</p>
                    <p className="text-xs text-muted-foreground mt-1">Based on active × lowest tier</p>
                  </div>
                  <div className="rounded-xl border border-border/60 p-4">
                    <p className="text-xs text-muted-foreground">Collection Rate</p>
                    <p className="text-2xl font-bold">{stats.collectionRate}%</p>
                    <p className="text-xs text-muted-foreground mt-1">vs expected this month</p>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="settings" className="space-y-4">

          {/* Notices Management */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-lg flex items-center gap-2">
                    <Bell className="h-5 w-5" /> Notices ({notices.length})
                  </CardTitle>
                  <CardDescription>Send announcements to all clients</CardDescription>
                </div>
                <Dialog open={noticeDialogOpen} onOpenChange={setNoticeDialogOpen}>
                  <DialogTrigger asChild>
                    <Button variant="pos" size="sm">
                      <Plus className="h-4 w-4 mr-2" /> New Notice
                    </Button>
                  </DialogTrigger>
                  <DialogContent>
                    <DialogHeader>
                      <DialogTitle>Create Notice</DialogTitle>
                    </DialogHeader>
                    <div className="space-y-4 mt-4">
                      <div className="space-y-2">
                        <Label htmlFor="notice-title">Title</Label>
                        <Input
                          id="notice-title"
                          placeholder="e.g., Price Increase Notice"
                          value={noticeTitle}
                          onChange={(e) => setNoticeTitle(e.target.value)}
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="notice-message">Message</Label>
                        <Textarea
                          id="notice-message"
                          placeholder="Write your announcement here..."
                          value={noticeMessage}
                          onChange={(e) => setNoticeMessage(e.target.value)}
                          rows={4}
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="notice-duration">Show for</Label>
                        <Select value={noticeEndsIn} onValueChange={setNoticeEndsIn}>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="1">1 day</SelectItem>
                            <SelectItem value="3">3 days</SelectItem>
                            <SelectItem value="7">7 days</SelectItem>
                            <SelectItem value="14">14 days</SelectItem>
                            <SelectItem value="30">30 days</SelectItem>
                            <SelectItem value="never">Forever</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="notice-target">Send to</Label>
                        <Select value={noticeTarget} onValueChange={(v) => setNoticeTarget(v as NoticeTarget)}>
                          <SelectTrigger>
                            <SelectValue placeholder="Select target" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="all">All Clients</SelectItem>
                            {businesses.map(b => (
                              <SelectItem key={b.id} value={b.id}>{b.name} ({b.payment_code})</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <Button variant="pos" className="w-full" onClick={createNotice}>
                        Create Notice
                      </Button>
                    </div>
                  </DialogContent>
                </Dialog>
              </div>
            </CardHeader>
            <CardContent className="space-y-2">
              {notices.length === 0 ? (
                <p className="text-sm text-muted-foreground">No notices yet.</p>
              ) : (
                notices.map((n) => {
                  const targetBiz = n.target_business_id ? businesses.find(b => b.id === n.target_business_id) : null;
                  return (
                    <div key={n.id} className="bg-secondary rounded-lg p-3 flex items-start justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="font-medium">{n.title}</p>
                          <Badge variant={n.is_active ? "default" : "secondary"}>
                            {n.is_active ? "Active" : "Inactive"}
                          </Badge>
                          {targetBiz ? (
                            <Badge variant="outline" className="text-xs">{targetBiz.name}</Badge>
                          ) : (
                            <Badge variant="outline" className="text-xs">All Clients</Badge>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground mt-1">{n.message}</p>
                        <p className="text-xs text-muted-foreground mt-1">
                          Ends: {n.ends_at ? new Date(n.ends_at).toLocaleDateString() : "Never"}
                        </p>
                      </div>
                      <div className="flex gap-2">
                        <Button variant="outline" size="sm" onClick={() => toggleNotice(n)}>
                          {n.is_active ? <PowerOff className="h-4 w-4" /> : <Power className="h-4 w-4" />}
                        </Button>
                        <Button variant="destructive" size="sm" onClick={() => deleteNotice(n)}>
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  );
                })
              )}
            </CardContent>
          </Card>
            </TabsContent>

            <TabsContent value="subscriptions" className="space-y-4">
          {/* Pending Payments */}
          <Card>

            <CardHeader>
              <CardTitle className="text-lg">Pending Payments ({pendingPayments.length})</CardTitle>
              <CardDescription>Approve or reject manual payments</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              {pendingPayments.length === 0 ? (
                <p className="text-sm text-muted-foreground">No pending payments.</p>
              ) : (
                pendingPayments.map((p) => {
                  const biz = businesses.find((b) => b.id === p.business_id);
                  return (
                    <div key={p.id} className="bg-secondary rounded-lg p-3 flex items-center justify-between">
                      <div>
                        <p className="font-medium">{biz?.name ?? "Unknown business"}</p>
                        <p className="text-xs text-muted-foreground">
                          {biz?.payment_code ?? ""} • ZMW {Number(p.amount).toFixed(2)} • {new Date(p.created_at).toLocaleString()}
                        </p>
                        {p.notes ? <p className="text-xs text-muted-foreground mt-1">{p.notes}</p> : null}
                      </div>
                      <div className="flex gap-2">
                        <Button variant="pos" size="sm" onClick={() => approve(p)}>
                          <CheckCircle2 className="h-4 w-4 mr-2" /> Approve
                        </Button>
                        <Button variant="outline" size="sm" onClick={() => reject(p)}>
                          <XCircle className="h-4 w-4 mr-2" /> Reject
                        </Button>
                      </div>
                    </div>
                  );
                })
              )}
            </CardContent>
          </Card>
            </TabsContent>

            <TabsContent value="businesses" className="space-y-4">
          {/* Businesses */}
          <Card>

            <CardHeader>
              <CardTitle className="text-lg">Businesses ({businesses.length})</CardTitle>
              <CardDescription>Manage subscriptions, lock/unlock accounts</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {businesses.length === 0 ? (
                <p className="text-sm text-muted-foreground">No businesses registered yet.</p>
              ) : (
                businesses.map((b) => {
                  const profile = getProfile(b.user_id);
                  return (
                    <div key={b.id} className="bg-secondary rounded-lg p-4 space-y-3">
                      <div className="flex items-start justify-between">
                        <div className="flex items-start gap-3">
                          <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
                            <Building2 className="h-5 w-5 text-primary" />
                          </div>
                          <div>
                            <p className="font-medium">{b.name}</p>
                            <p className="text-xs text-muted-foreground">Code: {b.payment_code}</p>
                            {profile && (
                              <p className="text-xs text-muted-foreground">Owner: {profile.full_name || profile.email}</p>
                            )}
                          </div>
                        </div>
                        <div className="flex flex-col items-end gap-2">
                          <div className="flex items-center gap-2">
                            {b.plan_tier ? (
                              <Badge variant="outline" className="text-xs">Plan: {b.plan_tier}</Badge>
                            ) : (
                              <Badge variant="outline" className="text-xs text-muted-foreground">Plan: Auto</Badge>
                            )}
                            {statusBadge(b.subscription_status, b.is_locked)}
                          </div>
                          <div className="flex items-center gap-2">
                            <Label className="text-xs text-muted-foreground">Set plan</Label>
                            <Select
                              value={b.plan_tier ?? "auto"}
                              onValueChange={(v) => setPlan(b, v)}
                            >
                              <SelectTrigger className="h-8 text-xs w-44">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="auto">Auto (by cashier count)</SelectItem>
                                {PRICING_TIERS.map((t) => (
                                  <SelectItem key={t.label} value={t.label}>
                                    {t.label}{t.priceZmw > 0 ? ` — K${t.priceZmw}/mo` : ' — Custom'}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                        </div>
                      </div>


                      {/* Contact Details */}
                      {(b.phone || b.email || b.address) && (
                        <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
                          {b.phone && (
                            <span className="flex items-center gap-1">
                              <Phone className="h-3 w-3" /> {b.phone}
                            </span>
                          )}
                          {b.email && (
                            <span className="flex items-center gap-1">
                              <Mail className="h-3 w-3" /> {b.email}
                            </span>
                          )}
                          {b.address && (
                            <span className="flex items-center gap-1">
                              <MapPin className="h-3 w-3" /> {b.address}
                            </span>
                          )}
                        </div>
                      )}
                      
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
                        <div className="bg-background/50 rounded-md p-2">
                          <p className="text-muted-foreground">Expires</p>
                          <p className="font-medium">
                            {b.subscription_expires_at 
                              ? new Date(b.subscription_expires_at).toLocaleDateString() 
                              : "N/A"}
                          </p>
                        </div>
                        <div className="bg-background/50 rounded-md p-2">
                          <p className="text-muted-foreground">Last Sync</p>
                          <p className="font-medium">{formatLastSync(b.last_sync_at)}</p>
                        </div>
                        <div className="bg-background/50 rounded-md p-2">
                          <p className="text-muted-foreground">Joined</p>
                          <p className="font-medium">{new Date(b.created_at).toLocaleDateString()}</p>
                        </div>
                        <div className="bg-background/50 rounded-md p-2">
                          <p className="text-muted-foreground">Status</p>
                          <p className="font-medium capitalize">{b.subscription_status}</p>
                        </div>
                      </div>
                      
                      <div className="flex items-center justify-between gap-2 pt-2 border-t border-border">
                        {/* Extend/Unextend Subscription */}
                        <div className="flex items-center gap-2 flex-wrap">
                          <Input
                            type="number"
                            min="1"
                            value={extendAmount[b.id] || 1}
                            onChange={(e) => setExtendAmount(prev => ({ ...prev, [b.id]: parseInt(e.target.value) || 1 }))}
                            className="w-16 h-8 text-xs"
                          />
                          <Select 
                            value={extendUnit[b.id] || 'months'}
                            onValueChange={(v) => setExtendUnit(prev => ({ ...prev, [b.id]: v as 'days' | 'weeks' | 'months' }))}
                          >
                            <SelectTrigger className="w-24 h-8 text-xs">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="days">Days</SelectItem>
                              <SelectItem value="weeks">Weeks</SelectItem>
                              <SelectItem value="months">Months</SelectItem>
                            </SelectContent>
                          </Select>
                          <Button variant="outline" size="sm" onClick={() => extendSubscription(b)}>
                            <Calendar className="h-4 w-4 mr-1" /> Extend
                          </Button>
                          <Button variant="secondary" size="sm" onClick={() => unextendSubscription(b)}>
                            <CalendarMinus className="h-4 w-4 mr-1" /> Reduce
                          </Button>
                        </div>

                        <div className="flex items-center gap-2">
                          <Button 
                            variant={b.is_locked ? "default" : "destructive"} 
                            size="sm"
                            onClick={() => toggleLock(b)}
                          >
                            {b.is_locked ? (
                              <>
                                <Power className="h-4 w-4 mr-2" /> Unlock
                              </>
                            ) : (
                              <>
                                <PowerOff className="h-4 w-4 mr-2" /> Lock
                              </>
                            )}
                          </Button>
                          <Button 
                            variant="outline" 
                            size="sm"
                            className="text-destructive hover:bg-destructive hover:text-destructive-foreground"
                            onClick={() => deleteBusiness(b)}
                          >
                            <Trash2 className="h-4 w-4 mr-2" /> Delete
                          </Button>
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </CardContent>
          </Card>
            </TabsContent>

            <TabsContent value="affiliates">
              <AdminAffiliatePanel />
            </TabsContent>

            <TabsContent value="payouts">
              <div className="text-center py-12 text-muted-foreground">
                <p className="text-lg font-medium">Payouts</p>
                <p className="text-sm mt-2">Affiliate payout management coming soon.</p>
              </div>
            </TabsContent>

          </Tabs>
        </main>
      </div>
    </>
  );
};

export default AdminDashboard;