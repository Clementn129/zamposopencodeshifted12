import { useCallback, useEffect, useState } from 'react';
import { Loader2, Plus, KeyRound, Power, Trash2, Users, PackagePlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { useOnlineStatus } from '@/hooks/useOnlineStatus';

const NETWORK_ERROR_RE = /fetch|network|failed to connect|timeout|offline/i;

// Postgres 42703 (direct SQL) / PGRST204 (PostgREST) both mean the column is
// not there. Either way the migration has not been applied, so the list must
// still load — this is the failure that first broke the cashier list.
const MISSING_COLUMN_RE = /column .* does not exist|PGRST204|42703/i;

interface Cashier {
  id: string;
  username: string;
  display_name: string | null;
  is_active: boolean;
  last_login_at: string | null;
  created_at: string;
  role: string;
  can_adjust_stock: boolean;
}

const ROLE_LABEL: Record<string, string> = {
  cashier: 'Cashier',
  kitchen_staff: 'Kitchen',
  manager: 'Manager',
};

import { getPricingTier, getPricingTierByLabel } from '@/lib/paymentDetails';

interface Props {
  businessId: string;
  paymentCode: string;
  planTier?: string | null;
  isRestaurant?: boolean;
}

const CashiersManager = ({ businessId, paymentCode, planTier, isRestaurant = false }: Props) => {
  const { toast } = useToast();
  const { isOnline } = useOnlineStatus();
  const [cashiers, setCashiers] = useState<Cashier[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  // Create dialog
  const [createOpen, setCreateOpen] = useState(false);
  const [newUsername, setNewUsername] = useState('');
  const [newName, setNewName] = useState('');
  const [newPin, setNewPin] = useState('');
  const [newRole, setNewRole] = useState('cashier');
  const [newStockAccess, setNewStockAccess] = useState(false);
  // False until the migration lands. The toggles hide rather than lie.
  const [stockAccessAvailable, setStockAccessAvailable] = useState(true);

  // Reset PIN dialog
  const [resetTarget, setResetTarget] = useState<Cashier | null>(null);
  const [resetPin, setResetPin] = useState('');

  const fetchCashiers = useCallback(async () => {
    if (!isOnline) {
      // Don't hit the network (or alarm the user with an error toast) when we
      // know we're offline. Settings stays usable; the list will load when
      // the connection returns.
      setLoading(false);
      return;
    }
    setLoading(true);

    const LEGACY_COLUMNS = 'id, username, display_name, is_active, last_login_at, created_at, role';
    const RICH_COLUMNS = `${LEGACY_COLUMNS}, can_adjust_stock`;

    const { data, error } = await supabase
      .from('business_cashiers')
      .select(RICH_COLUMNS)
      .eq('business_id', businessId)
      .order('created_at', { ascending: true });

    if (error && MISSING_COLUMN_RE.test(error.message)) {
      // Un-migrated database. Load the legacy shape so the page still works;
      // the stock toggle stays hidden rather than silently claiming OFF.
      const { data: legacy, error: legacyErr } = await supabase
        .from('business_cashiers')
        .select(LEGACY_COLUMNS)
        .eq('business_id', businessId)
        .order('created_at', { ascending: true });
      if (legacyErr) {
        console.warn('Cashiers fetch failed:', legacyErr.message);
        setLoading(false);
        return;
      }
      setStockAccessAvailable(false);
      setCashiers(
        ((legacy ?? []) as unknown as Cashier[]).map((c) => ({ ...c, can_adjust_stock: false })),
      );
      setLoading(false);
      return;
    }

    if (error) {
      // Network-class failures (flaky link, still mid-switch) are not a real
      // cashier problem — don't surface a scary toast for them.
      if (NETWORK_ERROR_RE.test(error.message)) {
        console.warn('Cashiers fetch failed (likely offline):', error.message);
      } else {
        toast({ variant: 'destructive', title: 'Failed to load cashiers', description: error.message });
      }
    } else {
      setStockAccessAvailable(true);
      setCashiers(
        ((data ?? []) as unknown as Cashier[]).map((c) => ({
          ...c,
          // Explicit `=== true`: an absent/null value must read as OFF.
          can_adjust_stock: c.can_adjust_stock === true,
        })),
      );
    }
    setLoading(false);
  }, [businessId, isOnline, toast]);

  useEffect(() => {
    void fetchCashiers();
  }, [fetchCashiers]);

  const callFn = useCallback(async (action: string, payload: Record<string, unknown>) => {
    const { data, error } = await supabase.functions.invoke('manage-cashier', {
      body: { ...payload, action, business_id: businessId },
    });
    if (error) {
      // Supabase wraps non-2xx into FunctionsHttpError; try to surface the JSON error
      let msg = error.message;
      const ctx = (error as unknown as { context?: { json?: () => Promise<{ error?: string; message?: string }> } }).context;
      try {
        const j = await ctx?.json?.();
        if (j?.message) msg = j.message;
        else if (j?.error) msg = j.error;
      } catch { /* ignore */ }
      throw new Error(msg);
    }
    return data;
  }, [businessId]);

  const activeCount = cashiers.filter(c => c.is_active).length;

  const requireOnline = (): boolean => {
    if (isOnline) return true;
    toast({ title: 'Offline', description: 'Cashiers can only be managed when you are online.' });
    return false;
  };

  const adminTier = planTier ? getPricingTierByLabel(planTier) : null;
  const cashierCap = adminTier?.maxCashiers ?? null;
  const atCap = cashierCap !== null && activeCount >= cashierCap;

  const handleCreate = async () => {
    if (atCap) {
      toast({ variant: 'destructive', title: 'Cashier limit reached', description: `Your plan allows a maximum of ${cashierCap} active cashier${cashierCap === 1 ? '' : 's'}. Contact admin to upgrade.` });
      return;
    }
    const username = newUsername.trim().toLowerCase();
    if (!/^[a-z0-9_]{2,20}$/.test(username)) {
      toast({ variant: 'destructive', title: 'Invalid username', description: 'Use 2-20 letters, numbers or underscore.' });
      return;
    }
    if (!/^\d{4,6}$/.test(newPin)) {
      toast({ variant: 'destructive', title: 'Invalid PIN', description: 'PIN must be 4-6 digits.' });
      return;
    }
    if (!requireOnline()) return;
    setBusy(true);
    try {
      await callFn('create', {
        username,
        pin: newPin,
        display_name: newName.trim() || null,
        role: newRole,
        can_adjust_stock: stockAccessAvailable ? newStockAccess : false,
      });
      toast({ title: 'Staff added', description: `${username} can now sign in with their PIN.` });
      setCreateOpen(false);
      setNewUsername(''); setNewName(''); setNewPin(''); setNewRole('cashier'); setNewStockAccess(false);
      await fetchCashiers();
    } catch (e) {
      toast({ variant: 'destructive', title: 'Could not add cashier', description: e instanceof Error ? e.message : 'Unknown error' });
    } finally {
      setBusy(false);
    }
  };

  const handleResetPin = async () => {
    if (!resetTarget) return;
    if (!/^\d{4,6}$/.test(resetPin)) {
      toast({ variant: 'destructive', title: 'Invalid PIN', description: 'PIN must be 4-6 digits.' });
      return;
    }
    if (!requireOnline()) return;
    setBusy(true);
    try {
      await callFn('reset_pin', { cashier_id: resetTarget.id, pin: resetPin });
      toast({ title: 'PIN reset', description: `New PIN for ${resetTarget.username} saved.` });
      setResetTarget(null); setResetPin('');
    } catch (e) {
      toast({ variant: 'destructive', title: 'Could not reset PIN', description: e instanceof Error ? e.message : 'Unknown error' });
    } finally {
      setBusy(false);
    }
  };

  const handleToggleActive = async (c: Cashier) => {
    if (!c.is_active && atCap) {
      toast({ variant: 'destructive', title: 'Cashier limit reached', description: `Your plan allows a maximum of ${cashierCap} active cashier${cashierCap === 1 ? '' : 's'}. Contact admin to upgrade.` });
      return;
    }
    if (!requireOnline()) return;
    setBusy(true);
    try {
      await callFn('set_active', { cashier_id: c.id, is_active: !c.is_active });
      await fetchCashiers();
    } catch (e) {
      toast({ variant: 'destructive', title: 'Failed', description: e instanceof Error ? e.message : 'Unknown error' });
    } finally {
      setBusy(false);
    }
  };

  const handleToggleStockAccess = async (c: Cashier) => {
    if (!requireOnline()) return;
    const next = !c.can_adjust_stock;
    setBusy(true);
    // Optimistic so the switch feels instant, rolled back on failure.
    setCashiers(prev => prev.map(x => x.id === c.id ? { ...x, can_adjust_stock: next } : x));
    try {
      // Owners already hold an UPDATE grant on business_cashiers via RLS, so
      // write the column directly. Routing this through the edge function would
      // make the toggle depend on that function being redeployed, which is not
      // something a schema change can keep in step.
      const { error } = await supabase
        .from('business_cashiers')
        .update({ can_adjust_stock: next })
        .eq('id', c.id)
        .eq('business_id', businessId);
      if (error) throw error;
      await fetchCashiers();
      toast({
        title: next ? 'Stock access granted' : 'Stock access removed',
        description: next
          ? `${c.display_name || c.username} can now request stock adjustments.`
          : `${c.display_name || c.username} can no longer adjust stock.`,
      });
    } catch (e) {
      setCashiers(prev => prev.map(x => x.id === c.id ? { ...x, can_adjust_stock: c.can_adjust_stock } : x));
      toast({ variant: 'destructive', title: 'Failed', description: e instanceof Error ? e.message : 'Unknown error' });
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (c: Cashier) => {
    if (!confirm(`Delete cashier "${c.username}"? This cannot be undone.`)) return;
    if (!requireOnline()) return;
    setBusy(true);
    try {
      await callFn('delete', { cashier_id: c.id });
      toast({ title: 'Cashier removed' });
      await fetchCashiers();
    } catch (e) {
      toast({ variant: 'destructive', title: 'Failed', description: e instanceof Error ? e.message : 'Unknown error' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2"><Users className="h-5 w-5" /> Cashiers</CardTitle>
            <CardDescription>
              Cashiers sell at the till, kitchen staff see the kitchen screen, and managers can also view dashboards.
            </CardDescription>
          </div>
          <Badge variant="secondary">{activeCount} active{cashierCap ? ` / ${cashierCap} max` : ''}</Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="rounded-lg bg-secondary/50 p-3 text-sm">
          <p className="font-medium">How cashiers sign in</p>
          <p className="text-muted-foreground mt-1">
            Share your <span className="font-mono font-semibold text-foreground">{paymentCode}</span> business code,
            their username, and PIN. They tap <span className="font-medium">"Cashier login"</span> on the sign-in screen.
          </p>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-6 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin mr-2" /> Loading…
          </div>
        ) : cashiers.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-6">No cashiers yet. Add one to let a worker use the till.</p>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {cashiers.map(c => (
              <li key={c.id} className="p-3 flex items-center gap-3 flex-wrap">
                <div className="flex-1 min-w-[160px]">
                  <p className="font-medium">{c.display_name || c.username}</p>
                  <p className="text-xs text-muted-foreground">
                    @{c.username} · {c.is_active ? <span className="text-green-600">Active</span> : <span className="text-muted-foreground">Disabled</span>}
                  </p>
                  <span className="inline-block mt-1 text-[11px] font-medium bg-primary/10 text-primary rounded-full px-2 py-0.5">
                    {ROLE_LABEL[c.role] ?? 'Cashier'}
                  </span>
                </div>
                <div className="flex items-center gap-1">
                  {stockAccessAvailable && (
                    <div className="flex items-center gap-2 mr-2">
                      <Switch
                        id={`stock-access-${c.id}`}
                        checked={c.can_adjust_stock}
                        disabled={busy}
                        onCheckedChange={() => handleToggleStockAccess(c)}
                        aria-label={`Allow stock adjustments for ${c.username}`}
                      />
                      <Label htmlFor={`stock-access-${c.id}`} className="text-xs text-muted-foreground cursor-pointer whitespace-nowrap">
                        <PackagePlus className="h-3.5 w-3.5 inline mr-1" />Stock access
                      </Label>
                    </div>
                  )}
                  <Button variant="ghost" size="sm" disabled={busy} onClick={() => { setResetTarget(c); setResetPin(''); }}>
                    <KeyRound className="h-4 w-4 mr-1" /> Reset PIN
                  </Button>
                  <Button variant="ghost" size="sm" disabled={busy} onClick={() => handleToggleActive(c)}>
                    <Power className="h-4 w-4 mr-1" /> {c.is_active ? 'Disable' : 'Enable'}
                  </Button>
                  <Button variant="ghost" size="sm" disabled={busy} onClick={() => handleDelete(c)}>
                    <Trash2 className="h-4 w-4 mr-1 text-destructive" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}

        <Button variant="pos" className="w-full" onClick={() => setCreateOpen(true)} disabled={busy || atCap}>
          <Plus className="h-4 w-4 mr-1" /> Add Cashier
        </Button>
      </CardContent>


      {/* Create dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add a cashier</DialogTitle>
            <DialogDescription>They'll sign in with the business code, username and PIN.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="c-username">Username</Label>
              <Input id="c-username" value={newUsername} onChange={(e) => setNewUsername(e.target.value)} placeholder="e.g. mary01" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="c-name">Display name (optional)</Label>
              <Input id="c-name" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="e.g. Mary Phiri" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="c-pin">PIN (4-6 digits)</Label>
              <Input id="c-pin" inputMode="numeric" pattern="[0-9]*" maxLength={6} value={newPin} onChange={(e) => setNewPin(e.target.value.replace(/\D/g, ''))} placeholder="••••" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="c-role">Role</Label>
              <Select value={newRole} onValueChange={setNewRole}>
                <SelectTrigger id="c-role" className="w-full">
                  <SelectValue placeholder="Select a role" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="cashier">Cashier — sells at the till</SelectItem>
                  {isRestaurant && (
                    <>
                      <SelectItem value="kitchen_staff">Kitchen staff — sees the kitchen screen</SelectItem>
                      <SelectItem value="manager">Manager — kitchen + dashboards</SelectItem>
                    </>
                  )}
                </SelectContent>
              </Select>
            </div>
            {stockAccessAvailable && (
              <div className="flex items-center justify-between gap-3 rounded-lg bg-secondary p-3">
                <Label htmlFor="c-stock-access" className="cursor-pointer">
                  <span className="font-medium">Allow stock adjustments</span>
                  <span className="block text-xs text-muted-foreground">
                    They can submit stock add/remove requests for you to approve.
                  </span>
                </Label>
                <Switch
                  id="c-stock-access"
                  checked={newStockAccess}
                  onCheckedChange={setNewStockAccess}
                />
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCreateOpen(false)} disabled={busy}>Cancel</Button>
            <Button variant="pos" onClick={handleCreate} disabled={busy}>
              {busy ? <><Loader2 className="h-4 w-4 animate-spin mr-1" /> Saving…</> : 'Create staff member'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reset PIN dialog */}
      <Dialog open={!!resetTarget} onOpenChange={(o) => { if (!o) setResetTarget(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reset PIN for @{resetTarget?.username}</DialogTitle>
            <DialogDescription>Enter the new 4-6 digit PIN. Share it with the cashier.</DialogDescription>
          </DialogHeader>
          <div className="space-y-1">
            <Label htmlFor="reset-pin">New PIN</Label>
            <Input id="reset-pin" inputMode="numeric" pattern="[0-9]*" maxLength={6} value={resetPin} onChange={(e) => setResetPin(e.target.value.replace(/\D/g, ''))} placeholder="••••" />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setResetTarget(null)} disabled={busy}>Cancel</Button>
            <Button variant="pos" onClick={handleResetPin} disabled={busy}>
              {busy ? <><Loader2 className="h-4 w-4 animate-spin mr-1" /> Saving…</> : 'Reset PIN'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
};

export default CashiersManager;
