import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, Users, Clock, DollarSign, ShoppingCart } from "lucide-react";
import { format } from "date-fns";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import ConnectionStatus from "@/components/ConnectionStatus";
import { useAuthContext } from "@/contexts/AuthContext";
import { useBusiness } from "@/hooks/useBusiness";
import { supabase } from "@/integrations/supabase/client";
import { formatZMW } from "@/lib/currency";
import { lusakaDayRange } from "@/lib/dateRange";



type Cashier = {
  id: string;
  authUserId: string | null;
  username: string;
  display_name: string | null;
  is_active: boolean;
  last_login_at: string | null;
};

type Stat = { count: number; revenue: number };

const CashierActivity = () => {
  const navigate = useNavigate();
  const { user, isLoading: authLoading } = useAuthContext();
  const { business, isLoading: bizLoading } = useBusiness(user?.id);
  const [cashiers, setCashiers] = useState<Cashier[]>([]);
  const [stats, setStats] = useState<Record<string, Stat>>({});
  const [ownerStat, setOwnerStat] = useState<Stat>({ count: 0, revenue: 0 });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!authLoading && !user) navigate("/auth");
  }, [authLoading, user, navigate]);

  const load = async () => {
    if (!business?.id) return;
    setLoading(true);
    try {
      const { from, to } = lusakaDayRange();
      const [{ data: cs }, { data: sales }] = await Promise.all([
        supabase
          .from("business_cashiers")
          .select("id, auth_user_id, username, display_name, is_active, last_login_at")
          .eq("business_id", business.id)
          .order("created_at")
          .limit(200),
        supabase
          .from("sales")
          .select("cashier_id, total, status")
          .eq("business_id", business.id)
          .gte("created_at", from.toISOString())
          .lte("created_at", to.toISOString())
          .limit(2000),
      ]);
      setCashiers((cs ?? []).map((c: any) => ({
        ...c,
        authUserId: c.auth_user_id || null,
      })) as Cashier[]);
      const agg: Record<string, Stat> = {};
      let owner: Stat = { count: 0, revenue: 0 };
      (sales ?? []).forEach((s: any) => {
        if (s.status === "refunded") return;
        const rev = Number(s.total) || 0;
        if (!s.cashier_id) {
          owner.count += 1;
          owner.revenue += rev;
          return;
        }
        const cur = agg[s.cashier_id] || { count: 0, revenue: 0 };
        cur.count += 1;
        cur.revenue += rev;
        agg[s.cashier_id] = cur;
      });
      setStats(agg);
      setOwnerStat(owner);
    } catch (e) {
      console.error("Failed to load cashier activity:", e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    if (!business?.id) return;
    const channel = supabase
      .channel(`cashier-activity-${business.id}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "sales", filter: `business_id=eq.${business.id}` }, () => { void load(); })
      .on("postgres_changes", { event: "*", schema: "public", table: "business_cashiers", filter: `business_id=eq.${business.id}` }, () => { void load(); })
      .subscribe();
    const onSync = () => { void load(); };
    window.addEventListener("zampos:sync-complete", onSync);
    // Fallback poll (realtime channel above already refreshes on sale/cashier
    // changes). Kept at 5 min to cut egress while keeping a safety net.
    const interval = setInterval(() => { void load(); }, 300000);
    return () => {
      void supabase.removeChannel(channel);
      window.removeEventListener("zampos:sync-complete", onSync);
      clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [business?.id]);


  if (authLoading || bizLoading) {
    return <div className="min-h-screen flex items-center justify-center">Loading...</div>;
  }
  if (!business) return null;

  return (
    <>
      <ConnectionStatus />
      <div className="min-h-screen bg-background safe-area-inset">
        <header className="bg-card border-b border-border px-4 py-4">
          <div className="flex items-center gap-3 max-w-4xl mx-auto">
            <Button variant="ghost" size="icon" onClick={() => navigate("/dashboard")}>
              <ArrowLeft className="w-5 h-5" />
            </Button>
            <div>
              <h1 className="font-display font-bold text-lg">Cashier Activity</h1>
              <p className="text-xs text-muted-foreground">Today's performance</p>
            </div>
          </div>
        </header>

        <main className="p-4 max-w-4xl mx-auto space-y-3">
          {/* Owner row */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center justify-between text-base">
                <span className="flex items-center gap-2"><Users className="w-4 h-4" /> Owner (You)</span>
                <Badge variant="secondary">Owner</Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-2 gap-3 text-sm">
              <div className="flex items-center gap-2"><ShoppingCart className="w-4 h-4 text-muted-foreground" /> {ownerStat.count} sales today</div>
              <div className="flex items-center gap-2"><DollarSign className="w-4 h-4 text-muted-foreground" /> {formatZMW(ownerStat.revenue)}</div>
            </CardContent>
          </Card>

          {loading && <p className="text-center text-sm text-muted-foreground">Loading cashiers...</p>}

          {!loading && cashiers.length === 0 && (
            <Card><CardContent className="p-6 text-center text-sm text-muted-foreground">No cashiers added yet. Add them from Settings.</CardContent></Card>
          )}

          {cashiers.map((c) => {
            const s = (c.authUserId ? stats[c.authUserId] : null) || { count: 0, revenue: 0 };
            return (
              <Card key={c.id}>
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center justify-between text-base">
                    <span>{c.display_name || c.username}</span>
                    <Badge variant={c.is_active ? "default" : "secondary"}>
                      {c.is_active ? "Active" : "Disabled"}
                    </Badge>
                  </CardTitle>
                  <p className="text-xs text-muted-foreground">@{c.username}</p>
                </CardHeader>
                <CardContent className="grid grid-cols-2 gap-3 text-sm">
                  <div className="flex items-center gap-2"><ShoppingCart className="w-4 h-4 text-muted-foreground" /> {s.count} sales today</div>
                  <div className="flex items-center gap-2"><DollarSign className="w-4 h-4 text-muted-foreground" /> {formatZMW(s.revenue)}</div>
                  <div className="flex items-center gap-2 col-span-2 text-muted-foreground">
                    <Clock className="w-4 h-4" />
                    {c.last_login_at ? `Last login ${format(new Date(c.last_login_at), "MMM d, HH:mm")}` : "Never logged in"}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </main>
      </div>
    </>
  );
};

export default CashierActivity;
