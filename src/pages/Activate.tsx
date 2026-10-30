import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { AlertTriangle, CheckCircle2, FileKey2, Loader2, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuthContext } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import {
  cacheBusiness,
  cacheOfflineCredentials,
  cacheServerTime,
  cacheSubscription,
  mergeServerProducts,
} from "@/lib/offlineStorage";
import {
  electronBridge,
  getLicenceStatus,
  isElectron,
  notifyLicenceChanged,
  type ActivationPayload,
} from "@/lib/electron";

const formatDate = (value?: string | null): string => {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
};

const Activate = () => {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { signInOffline, signInOfflineCashier } = useAuthContext();
  const params = new URLSearchParams(window.location.search);
  const type = params.get('type') === 'cashier' ? 'cashier' : 'owner';

  const [file, setFile] = useState<File | null>(null);
  const [fileBuffer, setFileBuffer] = useState<ArrayBuffer | null>(null);
  const [pin, setPin] = useState("");
  const [payload, setPayload] = useState<ActivationPayload | null>(null);
  const [password, setPassword] = useState("");
  const [cashierUsername, setCashierUsername] = useState("");
  const [cashierPin, setCashierPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [secretSaved, setSecretSaved] = useState(false);

  const desktop = isElectron();

  const handleUnseal = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    if (!desktop) {
      setError("Open this page inside the Sale Point desktop app.");
      return;
    }
    if (!file) {
      setError("Choose the activation file (.spact).");
      return;
    }
    setBusy(true);
    try {
      const bridge = electronBridge();
      if (!bridge?.activation) throw new Error("Activation bridge is unavailable.");
      const buffer = await file.arrayBuffer();
      const result = await bridge.activation.unseal(buffer, pin);
      if (!result.ok || !result.payload) {
        throw new Error(result.error || "Activation file could not be opened.");
      }
      setFileBuffer(buffer);
      setPayload(result.payload);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Activation file could not be opened.");
    } finally {
      setBusy(false);
    }
  };

  const handleActivate = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!payload) return;
    setError(null);
    setBusy(true);
    try {
      if (!fileBuffer) throw new Error("Choose the activation file again.");
      const bridge = electronBridge();
      if (!bridge?.activation?.commit) throw new Error("Activation bridge is unavailable.");

      // The main process verifies the owner password before it installs the
      // licence or stores the one-time sync secret.
      const commit = await bridge.activation.commit(fileBuffer, pin, password);
      if (!commit.ok || !commit.payload) {
        throw new Error(commit.error || "Activation failed.");
      }
      setSecretSaved(!!commit.secretSaved);
      notifyLicenceChanged();

      const status = await getLicenceStatus();
      if (!status?.valid) {
        throw new Error(status?.error || "Licence is missing or expired.");
      }

      const committed = commit.payload;
      const business = committed.business;
      const owner = committed.owner;
      const subscription = committed.subscription;
      const nowIso = new Date().toISOString();

      await cacheBusiness(
        {
          id: business.id,
          name: business.name,
          paymentCode: business.code || "",
          subscriptionStatus: subscription?.status || business.subscriptionStatus || "active",
          subscriptionExpiresAt:
            subscription?.expiresAt || business.subscriptionExpiresAt || status.expiresAt || null,
          isLocked: false,
          lastSyncAt: nowIso,
          phone: business.phone ?? null,
          email: business.email ?? null,
          address: business.address ?? null,
          taxMode: business.taxMode || "none",
          vatRate: business.vatRate ?? 16,
          customTaxName: business.customTaxName ?? null,
          customTaxRate: business.customTaxRate ?? null,
          tpin: business.tpin ?? null,
          logoUrl: business.logoUrl ?? null,
          vatNumber: business.vatNumber ?? null,
          businessType: business.businessType ?? null,
          planTier: subscription?.plan ?? null,
        },
        owner.userId,
      );

      cacheSubscription({
        expiresAt:
          subscription?.expiresAt || business.subscriptionExpiresAt || status.expiresAt || "",
        status: subscription?.status || business.subscriptionStatus || "active",
        lastSyncAt: nowIso,
        isLocked: false,
      });
      cacheServerTime(new Date());

      await cacheOfflineCredentials({
        email: owner.email,
        passwordHash: owner.passwordHash,
        userId: owner.userId,
        role: "owner",
        lastOnlineLogin: owner.lastOnlineLogin || nowIso,
      });

      const products = (committed.products || []).map((product) => ({
        id: product.id,
        businessId: business.id,
        createdAt: nowIso,
        name: product.name,
        price: Number(product.price) || 0,
        costPrice: product.costPrice ?? null,
        stock: Number(product.stock) || 0,
        openingStock: Number(product.stock) || 0,
        minimumStock: product.reorderLevel ?? 0,
        category: product.category ?? null,
        barcode: product.barcode ?? null,
        sku: product.sku ?? null,
        isActive: product.isActive ?? true,
        imageUrl: product.imageUrl ?? null,
        expiryDate: product.expiryDate ?? null,
      }));
      await mergeServerProducts(business.id, products);

      localStorage.setItem("zampos:role:" + owner.userId, "owner");
      localStorage.setItem("zampos_activation_complete", "1");

      const { error: signInError } = await signInOffline(owner.email, password);
      if (signInError) {
        toast({
          title: "Activation saved",
          description: "Data was installed. Sign in with the owner password to continue.",
        });
        navigate("/auth?activated=1", { replace: true });
        return;
      }

      toast({ title: "This PC is activated", description: `${business.name} is ready offline.` });
      navigate("/pos", { replace: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Activation failed.");
    } finally {
      setBusy(false);
    }
  };

  const handleActivateCashier = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const code = payload?.business?.code || localStorage.getItem('zampos_payment_code') || 'POS-ED345B';
      const uname = cashierUsername.trim().toLowerCase();
      const cpin = cashierPin.trim();
      if (!uname || !/^[a-z0-9_]{2,20}$/.test(uname)) throw new Error('Enter valid cashier username');
      if (!/^\d{4,6}$/.test(cpin)) throw new Error('PIN must be 4-6 digits');
      const id = 'offline-cashier-' + uname + '-' + Date.now();
      const { cacheOfflineCredentials, hashPassword, cacheCashierLookup } = await import('@/lib/offlineStorage');
      const passwordHash = await hashPassword('zampos-' + cpin);
      await cacheOfflineCredentials({ email: `c-offline-${uname}@zampos.local`, passwordHash, userId: id, role: 'cashier', lastOnlineLogin: new Date().toISOString() });
      await cacheCashierLookup({ lookupKey: `${code}:${uname}`, email: `c-offline-${uname}@zampos.local`, username: uname, businessCode: code });
      localStorage.setItem(`farmfront_cashier_lookup_${code}_${uname}`, JSON.stringify({ email: `c-offline-${uname}@zampos.local`, username: uname, businessCode: code }));
      localStorage.setItem(`zampos_cashier_${code}_${uname}`, JSON.stringify({ email: `c-offline-${uname}@zampos.local`, username: uname, businessCode: code }));
      const key = `farmfront_cashiers_${payload?.business?.id || code}`;
      const arr = JSON.parse(localStorage.getItem(key) || '[]');
      arr.push({ id, businessId: payload?.business?.id || code, username: uname, display_name: uname, is_active: true, role: 'cashier', created_at: new Date().toISOString(), can_adjust_stock: false, can_backdate: false });
      localStorage.setItem(key, JSON.stringify(arr));
      localStorage.setItem('zampos_activation_complete', '1');
      toast({ title: 'Cashier activated offline', description: `${uname} can login offline with Business Code ${code} and PIN ${cpin}.` });
      const { error: sErr } = await signInOfflineCashier(code, uname, cpin);
      if (sErr) { navigate('/auth?tab=cashier', { replace: true }); return; }
      navigate('/pos', { replace: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to activate cashier.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-lg">
        <CardHeader>
          <div className="mb-2 flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-full bg-primary/15">
              <FileKey2 className="h-5 w-5 text-primary" />
            </div>
            <div>
              <CardTitle>Activate this PC</CardTitle>
              <CardDescription>Offline setup for Sale Point on Windows.</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          {!desktop && (
            <div className="flex gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>Activation is only available in the installed Sale Point desktop app.</span>
            </div>
          )}

          {!payload ? (
            <form onSubmit={handleUnseal} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="activation-file">Activation file</Label>
                <Input
                  id="activation-file"
                  type="file"
                  accept=".spact,application/json"
                  onChange={(e) => {
                    setFile(e.target.files?.[0] || null);
                    setFileBuffer(null);
                    setPayload(null);
                  }}
                  disabled={!desktop || busy}
                />
                <p className="text-xs text-muted-foreground">
                  Choose the .spact file supplied with this installation.
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="activation-pin">Activation PIN</Label>
                <Input
                  id="activation-pin"
                  type="password"
                  inputMode="numeric"
                  value={pin}
                  onChange={(e) => setPin(e.target.value)}
                  placeholder="••••"
                  disabled={!desktop || busy}
                  required
                  minLength={4}
                />
              </div>
              {error && (
                <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
                  {error}
                </div>
              )}
              <Button type="submit" variant="pos" className="w-full" disabled={!desktop || busy}>
                {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Open activation file
              </Button>
            </form>
          ) : type === 'cashier' ? (
            <form onSubmit={handleActivateCashier} className="space-y-4">
              <div className="rounded-lg border bg-muted/40 p-4">
                <div className="flex items-center gap-2 text-sm font-semibold">
                  <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                  Activate cashier for offline login
                </div>
                <dl className="mt-3 grid gap-2 text-sm">
                  <div className="flex justify-between gap-4">
                    <dt className="text-muted-foreground">Business</dt>
                    <dd className="text-right font-medium">{payload.business.name}</dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-muted-foreground">Business code</dt>
                    <dd className="text-right font-mono">{payload.business.code || "—"}</dd>
                  </div>
                </dl>
              </div>
              <div className="space-y-2">
                <Label htmlFor="cashier-username">Cashier Username</Label>
                <Input id="cashier-username" value={cashierUsername} onChange={(e) => setCashierUsername(e.target.value)} placeholder="cashier" required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="cashier-pin">Cashier PIN (4-6 digits)</Label>
                <Input id="cashier-pin" type="password" inputMode="numeric" value={cashierPin} onChange={(e) => setCashierPin(e.target.value)} placeholder="2222" required />
              </div>
              {error && (
                <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
                  {error}
                </div>
              )}
              <Button type="submit" variant="pos" className="w-full" disabled={busy}>
                {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Activate Cashier Offline
              </Button>
              <Button type="button" variant="ghost" className="w-full" onClick={() => { setPayload(null); setError(null); }}>
                Back
              </Button>
            </form>
          ) : (
            <form onSubmit={handleActivate} className="space-y-4">
              <div className="rounded-lg border bg-muted/40 p-4">
                <div className="flex items-center gap-2 text-sm font-semibold">
                  <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                  Activation file verified
                </div>
                <dl className="mt-3 grid gap-2 text-sm">
                  <div className="flex justify-between gap-4">
                    <dt className="text-muted-foreground">Business</dt>
                    <dd className="text-right font-medium">{payload.business.name}</dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-muted-foreground">Business code</dt>
                    <dd className="text-right font-mono">{payload.business.code || "—"}</dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-muted-foreground">Owner</dt>
                    <dd className="text-right">{payload.owner.email}</dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-muted-foreground">Licence ends</dt>
                    <dd className="text-right">{formatDate(payload.business.subscriptionExpiresAt)}</dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-muted-foreground">Products</dt>
                    <dd className="text-right">{payload.products?.length ?? 0}</dd>
                  </div>
                </dl>
              </div>

              <div className="space-y-2">
                <Label htmlFor="activation-password">Owner password</Label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    id="activation-password"
                    type="password"
                    className="pl-10"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Enter the owner password"
                    autoComplete="current-password"
                    required
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  Confirms you are the business owner and unlocks the seeded offline account.
                </p>
              </div>

              {secretSaved && (
                <p className="text-xs text-muted-foreground">
                  The first online sign-in is saved securely on this PC and will be cleared after it
                  succeeds.
                </p>
              )}
              {error && (
                <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
                  {error}
                </div>
              )}

              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setPayload(null);
                    setFileBuffer(null);
                    setFile(null);
                    setPassword("");
                    setError(null);
                  }}
                  disabled={busy}
                >
                  Back
                </Button>
                <Button type="submit" variant="pos" className="flex-1" disabled={busy}>
                  {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Activate and open POS
                </Button>
              </div>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
};

export default Activate;
