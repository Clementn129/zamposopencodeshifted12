import { useCallback, useEffect, useState } from 'react';
import { Loader2, Plus, KeyRound, Power, Trash2, Users, PackagePlus, CalendarClock, Receipt } from 'lucide-react';
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
import { cacheCashierLookup, cacheOfflineCredentials, hashPassword, generateOfflineId } from '@/lib/offlineStorage';

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
  can_backdate: boolean;
  can_view_my_sales: boolean;
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
  const [newBackdate, setNewBackdate] = useState(false);
  // Default ON: a new cashier keeps the "My Sales" tab unless the owner opts out.
  const [newMySales, setNewMySales] = useState(true);
  // False until the migration lands. The toggles hide rather than lie.
  const [stockAccessAvailable, setStockAccessAvailable] = useState(true);
  const [backdateAvailable, setBackdateAvailable] = useState(false);
  const [mySalesAvailable, setMySalesAvailable] = useState(true);

  // Reset PIN dialog
  const [resetTarget, setResetTarget] = useState<Cashier | null>(null);
  const [resetPin, setResetPin] = useState('');

  const fetchCashiers = useCallback(async () => {
    try {
      const key = `farmfront_cashiers_${businessId}`;
      const raw = localStorage.getItem(key);
      if (raw) {
        const local = JSON.parse(raw) as any[];
        if (local && local.length > 0) {
          setCashiers(local.map((c: any) => ({ id: c.id, username: c.username, display_name: c.display_name, is_active: c.is_active, last_login_at: null, created_at: c.created_at, role: c.role || 'cashier', can_adjust_stock: !!c.can_adjust_stock, can_backdate: !!c.can_backdate, can_view_my_sales: c.can_view_my_sales !== false })));
          setStockAccessAvailable(true);
          setBackdateAvailable(true);
          setMySalesAvailable(true);
          setLoading(false);
          if (!isOnline) return;
        }
      }
    } catch {}
    if (!isOnline) {
      setLoading(false);
      return;
    }
    setLoading(true);

    const LEGACY_COLUMNS = 'id, username, display_name, is_active, last_login_at, created_at, role';
    const FULL_COLUMNS = `${LEGACY_COLUMNS}, can_adjust_stock, can_backdate, can_view_my_sales`;
    const NO_MY_SALES_COLUMNS = `${LEGACY_COLUMNS}, can_adjust_stock, can_backdate`;
    const STOCK_ONLY_COLUMNS = `${LEGACY_COLUMNS}, can_adjust_stock`;

    // Normalise one row. Optional grants read as OFF when their column exists but
    // is null/absent; My Sales is the exception because its default is ON.
    const mapRow = (c: Record<string, unknown>): Cashier => ({
      ...(c as unknown as Cashier),
      can_adjust_stock: c.can_adjust_stock === true,
      can_backdate: c.can_backdate === true,
      can_view_my_sales: c.can_view_my_sales !== false,
    });

    const { data, error } = await supabase
      .from('business_cashiers')
      .select(FULL_COLUMNS)
      .eq('business_id', businessId)
      .order('created_at', { ascending: true });

    if (error && MISSING_COLUMN_RE.test(error.message)) {
      // The My Sales migration may not have landed yet. Fall back to the
      // back-dating shape so that toggle keeps working, and hide only the
      // My Sales toggle instead of claiming it is OFF.
      const { data: noMySales, error: noMySalesErr } = await supabase
        .from('business_cashiers')
        .select(NO_MY_SALES_COLUMNS)
        .eq('business_id', businessId)
        .order('created_at', { ascending: true });

      if (!noMySalesErr) {
        setStockAccessAvailable(true);
        setBackdateAvailable(true);
        setMySalesAvailable(false);
        setCashiers(((noMySales ?? []) as unknown as Record<string, unknown>[]).map(mapRow));
        setLoading(false);
        return;
      }

      // The back-dating migration may not have landed yet either. Fall back to
      // the stock column alone and hide the other two toggles rather than
      // claiming they are OFF.
      const { data: stockOnly, error: stockErr } = await supabase
        .from('business_cashiers')
        .select(STOCK_ONLY_COLUMNS)
        .eq('business_id', businessId)
        .order('created_at', { ascending: true });

      if (!stockErr) {
        setStockAccessAvailable(true);
        setBackdateAvailable(false);
        setMySalesAvailable(false);
        setCashiers(((stockOnly ?? []) as unknown as Record<string, unknown>[]).map(mapRow));
        setLoading(false);
        return;
      }

      // None of the optional columns exist. Load the legacy shape so the page
      // still works; every toggle stays hidden rather than silently claiming OFF.
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
      setBackdateAvailable(false);
      setMySalesAvailable(false);
      setCashiers(((legacy ?? []) as unknown as Record<string, unknown>[]).map(mapRow));
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
      setBackdateAvailable(true);
      setMySalesAvailable(true);
      setCashiers(((data ?? []) as unknown as Record<string, unknown>[]).map(mapRow));
    }
    setLoading(false);
  }, [businessId, isOnline, toast]);

  useEffect(() => {
    void fetchCashiers();
  }, [fetchCashiers]);

  const callFn = useCallback(async (action: string, payload: Record<string, unknown>) => {
    // `functions.invoke` attaches the current Supabase access token. A stale or
    // missing token makes the edge function reject the call as "Not authenticated".
    // Refresh first so a merely-expired access token still succeeds, and send the
    // token explicitly so we always pass the freshest one.
    let session = (await supabase.auth.getSession()).data.session;
    const expiresSoon = session?.expires_at ? session.expires_at * 1000 < Date.now() + 60_000 : true;
    if (!session || expiresSoon) {
      const { data: refreshed } = await supabase.auth.refreshSession();
      if (refreshed.session) session = refreshed.session;
    }
    if (!session) {
      throw new Error('Your session has expired. Please sign out and sign in again.');
    }

    const { data, error } = await supabase.functions.invoke('manage-cashier', {
      body: { ...payload, action, business_id: businessId },
      headers: { Authorization: `Bearer ${session.access_token}` },
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
      if (/not authenticated/i.test(msg)) {
        msg = 'Your session has expired. Please sign out and sign in again.';
      }
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
    const username = newUsername.trim().toLowerCase();
    if (!/^[a-z0-9_]{2,20}$/.test(username)) {
      toast({ variant: 'destructive', title: 'Invalid username', description: 'Use 2-20 letters, numbers or underscore.' });
      return;
    }
    if (!/^\d{4,6}$/.test(newPin)) {
      toast({ variant: 'destructive', title: 'Invalid PIN', description: 'PIN must be 4-6 digits.' });
      return;
    }
    if (atCap) {
      toast({ variant: 'destructive', title: 'Cashier limit reached', description: `Your plan allows a maximum of ${cashierCap} active cashier${cashierCap === 1 ? '' : 's'}. Contact admin to upgrade.` });
      return;
    }
    if (!isOnline) {
      setBusy(true);
      try {
        const id = generateOfflineId();
        const now = new Date().toISOString();
        const localCashier: any = { id, businessId, username, display_name: newName.trim() || null, is_active: true, role: newRole, created_at: now, can_adjust_stock: stockAccessAvailable ? newStockAccess : false, can_backdate: backdateAvailable ? newBackdate : false, can_view_my_sales: mySalesAvailable ? newMySales : true };
        try {
          const key = `farmfront_cashiers_${businessId}`;
          const existing = JSON.parse(localStorage.getItem(key) || '[]');
          existing.push(localCashier);
          localStorage.setItem(key, JSON.stringify(existing));
        } catch {}
        try {
          const passwordHash = await hashPassword('zampos-' + newPin);
          await cacheOfflineCredentials({ email: `c-offline-${username}@zampos.local`, passwordHash, userId: id, role: 'cashier', lastOnlineLogin: now });
        } catch {}
        const paymentCode = (window as any).__ZAMPOS_PAYMENT_CODE__ || '';
        const code = paymentCode || businessId.slice(0, 8).toUpperCase();
        try {
          await cacheCashierLookup({ lookupKey: `${code}:${username}`, email: `c-offline-${username}@zampos.local`, username, businessCode: code });
        } catch {}
        try {
          localStorage.setItem(`farmfront_cashier_lookup_${code}_${username}`, JSON.stringify({ email: `c-offline-${username}@zampos.local`, username, businessCode: code }));
        } catch {}
        try {
          localStorage.setItem(`zampos_cashier_${code}_${username}`, JSON.stringify({ email: `c-offline-${username}@zampos.local`, username, businessCode: code, pinHash: 'cached' }));
        } catch {}
        toast({ title: 'Staff added (offline)', description: `${username} can login offline with business code and PIN.` });
        setCreateOpen(false);
        setNewUsername('');
        setNewName('');
        setNewPin('');
        setNewRole('cashier');
        setNewStockAccess(false);
        setNewBackdate(false);
        setNewMySales(true);
        await fetchCashiers();
        setBusy(false);
        return;
      } catch (e: any) {
        toast({ variant: 'destructive', title: 'Could not add cashier', description: e?.message || 'Unknown error' });
        setBusy(false);
        return;
      }
    }
    if (!requireOnline()) return;
    setBusy(true);
    try {
      const created = await callFn('create', {
        username,
        pin: newPin,
        display_name: newName.trim() || null,
        role: newRole,
        can_adjust_stock: stockAccessAvailable ? newStockAccess : false,
      });
      // manage-cashier does not carry can_backdate. Apply it with a direct
      // owner-scoped update so the new grant does not depend on an edge-function
      // redeploy. Failure is non-fatal: the cashier exists and the toggle can be
      // flipped later.
      if (backdateAvailable && newBackdate) {
        const cashierId = (created as { cashier?: { id?: string } } | null)?.cashier?.id;
        if (cashierId) {
          const { error: bdErr } = await supabase
            .from('business_cashiers')
            .update({ can_backdate: true })
            .eq('id', cashierId)
            .eq('business_id', businessId);
          if (bdErr) console.warn('Could not set back-dating grant on create:', bdErr.message);
        }
      }
      // Same approach for My Sales: the column defaults to ON, so only an
      // explicit opt-out needs writing. Failure is non-fatal.
      if (mySalesAvailable && !newMySales) {
        const cashierId = (created as { cashier?: { id?: string } } | null)?.cashier?.id;
        if (cashierId) {
          const { error: msErr } = await supabase
            .from('business_cashiers')
            .update({ can_view_my_sales: false })
            .eq('id', cashierId)
            .eq('business_id', businessId);
          if (msErr) console.warn('Could not hide My Sales on create:', msErr.message);
        }
      }
      toast({ title: 'Staff added', description: `${username} can now sign in with their PIN.` });
      setCreateOpen(false);
      setNewUsername(''); setNewName(''); setNewPin(''); setNewRole('cashier'); setNewStockAccess(false); setNewBackdate(false); setNewMySales(true);
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
    if (!isOnline) {
      setBusy(true);
      try {
        const { cacheOfflineCredentials, hashPassword } = await import('@/lib/offlineStorage');
        const passwordHash = await hashPassword('zampos-' + resetPin);
        await cacheOfflineCredentials({ email: `c-offline-${resetTarget.username}@zampos.local`, passwordHash, userId: resetTarget.id, role: 'cashier', lastOnlineLogin: new Date().toISOString() });
        toast({ title: 'PIN reset (offline)', description: `New PIN for ${resetTarget.username} saved locally.` });
        setResetTarget(null); setResetPin('');
      } catch (e) {
        toast({ variant: 'destructive', title: 'Could not reset PIN', description: e instanceof Error ? e.message : 'Unknown error' });
      } finally {
        setBusy(false);
      }
      return;
    }
    if (!requireOnline()) return;
    setBusy(true);
    try {
      await callFn('reset_pin', { cashier_id: resetTarget.id, pin: resetPin });
      try {
        const { cacheOfflineCredentials, hashPassword } = await import('@/lib/offlineStorage');
        const passwordHash = await hashPassword('zampos-' + resetPin);
        await cacheOfflineCredentials({ email: `c-offline-${resetTarget.username}@zampos.local`, passwordHash, userId: resetTarget.id, role: 'cashier', lastOnlineLogin: new Date().toISOString() });
      } catch {}
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
    if (!isOnline) {
      try {
        const key = `farmfront_cashiers_${businessId}`;
        const raw = localStorage.getItem(key);
        const arr = raw ? JSON.parse(raw) : [];
        const updated = arr.map((x: any) => x.id === c.id ? { ...x, is_active: !c.is_active } : x);
        localStorage.setItem(key, JSON.stringify(updated));
        toast({ title: c.is_active ? 'Cashier disabled (offline)' : 'Cashier enabled (offline)' });
        await fetchCashiers();
        return;
      } catch (e) {
        toast({ variant: 'destructive', title: 'Failed', description: e instanceof Error ? e.message : 'Unknown error' });
        return;
      }
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

  const handleToggleBackdate = async (c: Cashier) => {
    if (!requireOnline()) return;
    const next = !c.can_backdate;
    setBusy(true);
    // Optimistic so the switch feels instant, rolled back on failure.
    setCashiers(prev => prev.map(x => x.id === c.id ? { ...x, can_backdate: next } : x));
    try {
      // Direct owner-scoped update keeps the toggle independent of the
      // manage-cashier edge function, which does not know this column.
      const { error } = await supabase
        .from('business_cashiers')
        .update({ can_backdate: next })
        .eq('id', c.id)
        .eq('business_id', businessId);
      if (error) throw error;
      await fetchCashiers();
      toast({
        title: next ? 'Back-dating allowed' : 'Back-dating removed',
        description: next
          ? `${c.display_name || c.username} can now save sales on a past date.`
          : `${c.display_name || c.username} can no longer back-date sales.`,
      });
    } catch (e) {
      setCashiers(prev => prev.map(x => x.id === c.id ? { ...x, can_backdate: c.can_backdate } : x));
      toast({ variant: 'destructive', title: 'Failed', description: e instanceof Error ? e.message : 'Unknown error' });
    } finally {
      setBusy(false);
    }
  };

  const handleToggleMySales = async (c: Cashier) => {
    if (!requireOnline()) return;
    const next = !c.can_view_my_sales;
    setBusy(true);
    // Optimistic so the switch feels instant, rolled back on failure.
    setCashiers(prev => prev.map(x => x.id === c.id ? { ...x, can_view_my_sales: next } : x));
    try {
      // Direct owner-scoped update keeps the toggle independent of the
      // manage-cashier edge function, which does not know this column.
      const { error } = await supabase
        .from('business_cashiers')
        .update({ can_view_my_sales: next })
        .eq('id', c.id)
        .eq('business_id', businessId);
      if (error) throw error;
      await fetchCashiers();
      toast({
        title: next ? 'My Sales shown' : 'My Sales hidden',
        description: next
          ? `${c.display_name || c.username} can see and reprint their own sales again.`
          : `${c.display_name || c.username} will no longer see the My Sales tab.`,
      });
    } catch (e) {
      setCashiers(prev => prev.map(x => x.id === c.id ? { ...x, can_view_my_sales: c.can_view_my_sales } : x));
      toast({ variant: 'destructive', title: 'Failed', description: e instanceof Error ? e.message : 'Unknown error' });
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (c: Cashier) => {
    if (!isOnline) {
      try {
        const key = `farmfront_cashiers_${businessId}`;
        const raw = localStorage.getItem(key);
        const arr = raw ? JSON.parse(raw) : [];
        const updated = arr.filter((x: any) => x.id !== c.id);
        localStorage.setItem(key, JSON.stringify(updated));
        try {
          const { removeLocalCashier } = await import('@/lib/offlineStorage');
          await removeLocalCashier(c.id);
        } catch {}
        toast({ title: 'Cashier removed (offline)' });
        await fetchCashiers();
        return;
      } catch (e) {
        toast({ variant: 'destructive', title: 'Failed', description: e instanceof Error ? e.message : 'Unknown error' });
        return;
      }
    }
    if (!requireOnline()) return;
    setBusy(true);
    try {
      await callFn('delete', { cashier_id: c.id });
      try {
        const key = `farmfront_cashiers_${businessId}`;
        const raw = localStorage.getItem(key);
        const arr = raw ? JSON.parse(raw) : [];
        const updated = arr.filter((x: any) => x.id !== c.id);
        localStorage.setItem(key, JSON.stringify(updated));
      } catch {}
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
              <li key={c.id} className="p-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex-1 min-w-0">
                  <p className="font-medium truncate">{c.display_name || c.username}</p>
                  <p className="text-xs text-muted-foreground">
                    @{c.username} {c.is_active ? <span className="text-green-600">Active</span> : <span className="text-muted-foreground">Disabled</span>}
                  </p>
                  <span className="inline-block mt-1 text-[11px] font-medium bg-primary/10 text-primary rounded-full px-2 py-0.5">
                    {ROLE_LABEL[c.role] ?? 'Cashier'}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-1 sm:justify-end sm:shrink-0">
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
                  {backdateAvailable && (
                    <div className="flex items-center gap-2 mr-2">
                      <Switch
                        id={`backdate-${c.id}`}
                        checked={c.can_backdate}
                        disabled={busy}
                        onCheckedChange={() => handleToggleBackdate(c)}
                        aria-label={`Allow back-dating for ${c.username}`}
                      />
                      <Label htmlFor={`backdate-${c.id}`} className="text-xs text-muted-foreground cursor-pointer whitespace-nowrap">
                        <CalendarClock className="h-3.5 w-3.5 inline mr-1" />Back-date
                      </Label>
                    </div>
                  )}
                  {mySalesAvailable && (
                    <div className="flex items-center gap-2 mr-2">
                      <Switch
                        id={`my-sales-${c.id}`}
                        checked={c.can_view_my_sales}
                        disabled={busy}
                        onCheckedChange={() => handleToggleMySales(c)}
                        aria-label={`Show the My Sales tab for ${c.username}`}
                      />
                      <Label htmlFor={`my-sales-${c.id}`} className="text-xs text-muted-foreground cursor-pointer whitespace-nowrap">
                        <Receipt className="h-3.5 w-3.5 inline mr-1" />My Sales
                      </Label>
                    </div>
                  )}
                  <Button variant="ghost" size="sm" disabled={busy} aria-label={`Reset PIN for ${c.username}`} onClick={() => { setResetTarget(c); setResetPin(''); }}>
                    <KeyRound className="h-4 w-4 sm:mr-1" /> <span className="hidden sm:inline">Reset PIN</span>
                  </Button>
                  <Button variant="ghost" size="sm" disabled={busy} aria-label={c.is_active ? `Disable ${c.username}` : `Enable ${c.username}`} onClick={() => handleToggleActive(c)}>
                    <Power className="h-4 w-4 sm:mr-1" /> <span className="hidden sm:inline">{c.is_active ? 'Disable' : 'Enable'}</span>
                  </Button>
                  <Button variant="ghost" size="sm" disabled={busy} aria-label={`Delete ${c.username}`} onClick={() => handleDelete(c)}>
                    <Trash2 className="h-4 w-4 text-destructive sm:mr-1" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}

        <Button
          variant="pos"
          className="w-full"
          onClick={() => {
            if (atCap) {
              toast({ variant: 'destructive', title: 'Cashier limit reached', description: `Your plan allows a maximum of ${cashierCap} active cashier${cashierCap === 1 ? '' : 's'}. Contact admin to upgrade.` });
              return;
            }
            setCreateOpen(true);
          }}
          disabled={busy}
        >
          <Plus className="h-4 w-4 mr-1" /> Add Cashier
        </Button>
        {atCap && (
          <p className="text-xs text-amber-600 dark:text-amber-400 text-center">
            {activeCount} active cashier{activeCount === 1 ? '' : 's'} used — your plan allows {cashierCap}. Contact admin to upgrade.
          </p>
        )}
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
            {backdateAvailable && (
              <div className="flex items-center gap-3 rounded-lg border p-3">
                <Label htmlFor="c-backdate" className="flex-1 text-sm">
                  <span className="font-medium">Allow back-dating</span>
                  <span className="block text-xs text-muted-foreground">
                    They may save sales against a past date. The business back-dating switch must also be on.
                  </span>
                </Label>
                <Switch
                  id="c-backdate"
                  checked={newBackdate}
                  onCheckedChange={setNewBackdate}
                />
              </div>
            )}
            {mySalesAvailable && (
              <div className="flex items-center gap-3 rounded-lg border p-3">
                <Label htmlFor="c-my-sales" className="flex-1 text-sm">
                  <span className="font-medium">Show the My Sales tab</span>
                  <span className="block text-xs text-muted-foreground">
                    They can review and reprint only their own sales. Turn off if you don't want staff seeing their sales.
                  </span>
                </Label>
                <Switch
                  id="c-my-sales"
                  checked={newMySales}
                  onCheckedChange={setNewMySales}
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
