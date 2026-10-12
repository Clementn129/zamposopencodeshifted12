import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, FileClock } from "lucide-react";
import { format } from "date-fns";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import ConnectionStatus from "@/components/ConnectionStatus";
import { useAuthContext } from "@/contexts/AuthContext";
import { useBusiness } from "@/hooks/useBusiness";
import { supabase } from "@/integrations/supabase/client";

type AuditEntry = {
  id: string;
  table_name: string;
  action: string;
  actor_label: string | null;
  record_id: string | null;
  created_at: string;
};

const ACTION_COLOR: Record<string, string> = {
  INSERT: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  UPDATE: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  DELETE: "bg-red-500/15 text-red-700 dark:text-red-400",
};

const AuditLog = () => {
  const navigate = useNavigate();
  const { user, isLoading: authLoading } = useAuthContext();
  const { business, isLoading: bizLoading } = useBusiness(user?.id);
  const [logs, setLogs] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!authLoading && !user) navigate("/auth");
  }, [authLoading, user, navigate]);

  useEffect(() => {
    if (!business?.id) return;
    let cancelled = false;
    supabase
      .from("audit_logs" as any)
      .select("id, table_name, action, actor_label, record_id, created_at")
      .eq("business_id", business.id)
      .order("created_at", { ascending: false })
      .limit(200)
      .then(({ data }) => {
        if (cancelled) return;
        setLogs(((data ?? []) as unknown) as AuditEntry[]);
        setLoading(false);
      }, () => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [business?.id]);

  if (authLoading || bizLoading) return <div className="min-h-screen flex items-center justify-center">Loading...</div>;
  if (!business) return null;

  return (
    <>
      <ConnectionStatus />
      <div className="min-h-screen bg-background safe-area-inset">
        <header className="bg-card border-b border-border px-4 py-4">
          <div className="flex items-center gap-3 max-w-4xl mx-auto">
            <Button variant="ghost" size="icon" onClick={() => navigate("/dashboard")}><ArrowLeft className="w-5 h-5" /></Button>
            <div>
              <h1 className="font-display font-bold text-lg">Audit Log</h1>
              <p className="text-xs text-muted-foreground">Last 200 changes</p>
            </div>
          </div>
        </header>

        <main className="p-4 max-w-4xl mx-auto space-y-2">
          {loading && <p className="text-center text-sm text-muted-foreground py-6">Loading...</p>}
          {!loading && logs.length === 0 && (
            <Card><CardContent className="p-6 text-center text-sm text-muted-foreground">
              <FileClock className="w-8 h-8 mx-auto mb-2 opacity-50" />
              No activity recorded yet.
            </CardContent></Card>
          )}
          {logs.map((l) => (
            <Card key={l.id}>
              <CardContent className="p-3 flex items-center justify-between text-sm">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <Badge className={ACTION_COLOR[l.action] || ""} variant="outline">{l.action}</Badge>
                    <span className="font-medium capitalize">{l.table_name.replace(/_/g, " ")}</span>
                  </div>
                  <p className="text-xs text-muted-foreground mt-1 truncate">
                    by {l.actor_label || "system"} · {format(new Date(l.created_at), "MMM d, HH:mm")}
                  </p>
                </div>
              </CardContent>
            </Card>
          ))}
        </main>
      </div>
    </>
  );
};

export default AuditLog;
