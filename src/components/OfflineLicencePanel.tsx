import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, FolderOpen, KeyRound, Loader2, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import {
  getDataDir,
  getLicenceStatus,
  importLicenceToken,
  isElectron,
  LICENCE_CHANGED_EVENT,
  openDataDir,
  type LicenceStatus,
} from "@/lib/electron";

const formatDate = (value?: string | null): string => {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
};

const OfflineLicencePanel = ({ compact = false }: { compact?: boolean }) => {
  const { toast } = useToast();
  const [status, setStatus] = useState<LicenceStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [token, setToken] = useState("");
  const [importing, setImporting] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [dataDir, setDataDir] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    if (!isElectron()) {
      setLoading(false);
      return;
    }
    const next = await getLicenceStatus();
    setStatus(next);
    setLoading(false);
    if (!next?.valid) setShowImport(true);
  }, []);

  useEffect(() => {
    void refresh();
    if (!isElectron()) return;
    void getDataDir().then(setDataDir);
    const onChange = () => void refresh();
    window.addEventListener(LICENCE_CHANGED_EVENT, onChange);
    const timer = window.setInterval(() => void refresh(), 60_000);
    return () => {
      window.removeEventListener(LICENCE_CHANGED_EVENT, onChange);
      window.clearInterval(timer);
    };
  }, [refresh]);

  if (!isElectron()) return null;

  const handleImport = async () => {
    const value = token.trim();
    if (!value) {
      toast({ variant: "destructive", title: "Paste a licence key first" });
      return;
    }
    setImporting(true);
    try {
      const result = await importLicenceToken(value);
      if (!result.ok) {
        toast({
          variant: "destructive",
          title: "Licence rejected",
          description: result.error || "The key could not be verified.",
        });
        return;
      }
      setToken("");
      setStatus(result.status || null);
      setShowImport(false);
      toast({
        title: "Licence installed",
        description: result.status?.expiresAt
          ? `Valid until ${formatDate(result.status.expiresAt)}.`
          : "The offline licence is active.",
      });
      await refresh();
    } finally {
      setImporting(false);
    }
  };

  const handleFile = async (file: File | null) => {
    if (!file) return;
    try {
      setToken((await file.text()).trim());
    } catch {
      toast({ variant: "destructive", title: "Could not read that file" });
    }
  };

  const valid = !!status?.valid;
  const expired = !!status?.expired || (!!status?.expiresAt && !valid);

  return (
    <Card className={compact ? "border-primary/20" : undefined}>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-lg">
          <KeyRound className="h-5 w-5" />
          Offline Licence
        </CardTitle>
        <CardDescription>
          Allows this PC to keep selling without internet until the licence end date.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Checking licence…
          </div>
        ) : valid ? (
          <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3">
            <div className="flex items-center gap-2 text-sm font-semibold text-emerald-700">
              <CheckCircle2 className="h-4 w-4" /> Licence active
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              Ends {formatDate(status?.expiresAt)} · {status?.daysRemaining ?? 0} day
              {(status?.daysRemaining ?? 0) === 1 ? "" : "s"} remaining
              {status?.businessCode ? ` · ${status.businessCode}` : ""}
            </p>
            {status?.rollbackDetected && (
              <p className="mt-2 text-xs text-amber-700">
                The computer clock was moved backwards. The licence still follows the last trusted
                date.
              </p>
            )}
          </div>
        ) : (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
            <div className="flex items-center gap-2 text-sm font-semibold text-amber-800">
              <ShieldAlert className="h-4 w-4" />
              {expired ? "Licence expired" : "No offline licence"}
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {status?.expiresAt
                ? `The last licence ended on ${formatDate(status.expiresAt)}. Paste a new key to continue offline.`
                : "Paste a licence key from the supplier to allow offline use."}
            </p>
            {status?.error && <p className="mt-1 text-xs text-muted-foreground">{status.error}</p>}
          </div>
        )}

        {showImport ? (
          <div className="space-y-3">
            <Textarea
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="Paste your SP1 licence key or open the .splic file"
              className="min-h-[90px] font-mono text-xs"
            />
            <div className="flex flex-wrap gap-2">
              <input
                ref={fileRef}
                type="file"
                accept=".splic,.txt,text/plain"
                className="hidden"
                onChange={(e) => void handleFile(e.target.files?.[0] || null)}
              />
              <Button type="button" variant="outline" onClick={() => fileRef.current?.click()}>
                Choose file
              </Button>
              <Button type="button" variant="pos" onClick={handleImport} disabled={importing}>
                {importing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Install licence
              </Button>
              {valid && (
                <Button type="button" variant="ghost" onClick={() => setShowImport(false)}>
                  Cancel
                </Button>
              )}
            </div>
          </div>
        ) : (
          <Button type="button" variant="outline" size="sm" onClick={() => setShowImport(true)}>
            Replace licence
          </Button>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
          <p className="max-w-[70%] truncate text-xs text-muted-foreground" title={dataDir || ""}>
            Data folder: {dataDir || "—"}
          </p>
          <Button type="button" variant="ghost" size="sm" onClick={() => void openDataDir()}>
            <FolderOpen className="mr-2 h-4 w-4" /> Open
          </Button>
        </div>
      </CardContent>
    </Card>
  );
};

export default OfflineLicencePanel;
