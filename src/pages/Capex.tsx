import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Plus, Trash2, Pencil, HardHat, WifiOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useBusiness } from '@/hooks/useBusiness';
import { useOnlineStatus } from '@/hooks/useOnlineStatus';
import { useToast } from '@/hooks/use-toast';
import { supabase } from '@/integrations/supabase/client';
import { formatZMW } from '@/lib/currency';
import { CAPEX_CATEGORIES, CAPEX_CATEGORY_LABELS } from '@/lib/capex';

// A missing table/column means the migration has not been applied yet. The
// owner needs to be told that plainly rather than shown an empty register that
// looks like "you have spent nothing".
const isMissingSchema = (message: string) =>
  /does not exist|schema cache|PGRST205|42P01|42703/i.test(message);

type CapexRow = {
  id: string;
  name: string;
  amount: number;
  capex_category: string;
  vendor: string | null;
  purchase_date: string;
  notes: string | null;
};

const Capex = () => {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { isOnline } = useOnlineStatus();
  const { business } = useBusiness();

  const [rows, setRows] = useState<CapexRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [schemaMissing, setSchemaMissing] = useState(false);

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<CapexRow | null>(null);
  const [saving, setSaving] = useState(false);

  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');
  const [category, setCategory] = useState<string>('equipment');
  const [vendor, setVendor] = useState('');
  const [purchaseDate, setPurchaseDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState('');

  const load = useCallback(async () => {
    if (!business?.id || !isOnline) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const { data, error } = await supabase
      .from('capex')
      .select('id, name, amount, capex_category, vendor, purchase_date, notes')
      .eq('business_id', business.id)
      .order('purchase_date', { ascending: false })
      .order('created_at', { ascending: false });

    if (error) {
      if (isMissingSchema(error.message)) {
        setSchemaMissing(true);
      } else {
        toast({ variant: 'destructive', title: 'Could not load CAPEX', description: error.message });
      }
      setRows([]);
    } else {
      setSchemaMissing(false);
      setRows((data ?? []) as unknown as CapexRow[]);
    }
    setLoading(false);
  }, [business?.id, isOnline, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const total = useMemo(
    () => rows.reduce((sum, r) => sum + (Number(r.amount) || 0), 0),
    [rows],
  );

  const byCategory = useMemo(() => {
    const map = new Map<string, number>();
    for (const r of rows) {
      const key = r.capex_category || 'other';
      map.set(key, (map.get(key) ?? 0) + (Number(r.amount) || 0));
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1]);
  }, [rows]);

  const resetForm = () => {
    setName('');
    setAmount('');
    setCategory('equipment');
    setVendor('');
    setPurchaseDate(new Date().toISOString().slice(0, 10));
    setNotes('');
    setEditing(null);
  };

  const openCreate = () => {
    resetForm();
    setOpen(true);
  };

  const openEdit = (row: CapexRow) => {
    setEditing(row);
    setName(row.name);
    setAmount(String(row.amount));
    setCategory(row.capex_category || 'other');
    setVendor(row.vendor ?? '');
    setPurchaseDate(row.purchase_date);
    setNotes(row.notes ?? '');
    setOpen(true);
  };

  const save = async () => {
    if (!business?.id) return;
    if (!name.trim()) {
      toast({ variant: 'destructive', title: 'Name required', description: 'What was this purchase for?' });
      return;
    }
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) {
      toast({ variant: 'destructive', title: 'Invalid amount', description: 'Enter an amount greater than zero.' });
      return;
    }

    setSaving(true);
    try {
      if (editing) {
        const { error } = await supabase
          .from('capex')
          .update({
            name: name.trim(),
            amount: value,
            capex_category: category,
            vendor: vendor.trim() || null,
            purchase_date: purchaseDate,
            notes: notes.trim() || null,
          })
          .eq('id', editing.id)
          .eq('business_id', business.id);
        if (error) throw error;
        toast({ title: 'CAPEX entry updated' });
      } else {
        const { error } = await supabase.from('capex').insert({
          business_id: business.id,
          name: name.trim(),
          amount: value,
          capex_category: category,
          vendor: vendor.trim() || null,
          purchase_date: purchaseDate,
          notes: notes.trim() || null,
        });
        if (error) throw error;
        toast({ title: 'CAPEX recorded', description: `${name.trim()} — ${formatZMW(value)}` });
      }
      setOpen(false);
      resetForm();
      await load();
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Could not save this entry';
      toast({
        variant: 'destructive',
        title: 'Could not save CAPEX',
        description: isMissingSchema(msg)
          ? 'The CAPEX register needs its database migration before it can save entries.'
          : msg,
      });
    } finally {
      setSaving(false);
    }
  };

  const remove = async (row: CapexRow) => {
    if (!business?.id) return;
    const { error } = await supabase
      .from('capex')
      .delete()
      .eq('id', row.id)
      .eq('business_id', business.id);
    if (error) {
      toast({ variant: 'destructive', title: 'Could not delete', description: error.message });
      return;
    }
    setRows((prev) => prev.filter((r) => r.id !== row.id));
    toast({ title: 'CAPEX entry deleted' });
  };

  if (!business?.capexEnabled) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-6">
        <Card className="max-w-md">
          <CardHeader>
            <CardTitle>CAPEX is turned off</CardTitle>
            <CardDescription>
              Turn on the CAPEX register in Settings to start recording capital purchases.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex gap-2">
            <Button onClick={() => navigate('/settings')}>Open Settings</Button>
            <Button variant="outline" onClick={() => navigate(-1)}>Go back</Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b bg-card sticky top-0 z-10">
        <div className="container mx-auto px-4 py-3 flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => navigate(-1)} aria-label="Back">
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <HardHat className="h-5 w-5 text-primary" />
          <div className="flex-1">
            <h1 className="text-lg font-semibold">CAPEX Register</h1>
            <p className="text-xs text-muted-foreground">Capital purchases, tracked separately from expenses</p>
          </div>
          <Button onClick={openCreate} disabled={!isOnline || schemaMissing}>
            <Plus className="h-4 w-4" /> Add
          </Button>
        </div>
      </header>

      <main className="container mx-auto px-4 py-6 space-y-6">
        {!isOnline && (
          <Card className="border-warning/50 bg-warning/5">
            <CardContent className="flex items-center gap-3 py-3">
              <WifiOff className="h-4 w-4 shrink-0" />
              <p className="text-sm">
                You are offline. CAPEX entries need a connection — reconnect to add or edit them.
              </p>
            </CardContent>
          </Card>
        )}

        {schemaMissing && (
          <Card className="border-destructive/50 bg-destructive/5">
            <CardContent className="py-3">
              <p className="text-sm font-medium">The CAPEX table has not been created yet.</p>
              <p className="text-sm text-muted-foreground">
                Run the CAPEX database migration, then reload this page.
              </p>
            </CardContent>
          </Card>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Card>
            <CardHeader>
              <CardDescription>Total capital spend</CardDescription>
              <CardTitle className="text-3xl">{formatZMW(total)}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-xs text-muted-foreground">
                Excluded from revenue, cost of sales and profit. This is a record, not an expense.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">By category</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {byCategory.length === 0 ? (
                <p className="text-sm text-muted-foreground">Nothing recorded yet.</p>
              ) : (
                byCategory.map(([key, value]) => (
                  <div key={key} className="flex items-center justify-between text-sm">
                    <span>{CAPEX_CATEGORY_LABELS[key] ?? key}</span>
                    <span className="font-medium tabular-nums">{formatZMW(value)}</span>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Entries</CardTitle>
            <CardDescription>{rows.length} recorded</CardDescription>
          </CardHeader>
          <CardContent>
            {loading ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : rows.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No CAPEX recorded. Add your first capital purchase to get started.
              </p>
            ) : (
              <div className="space-y-2">
                {rows.map((row) => (
                  <div
                    key={row.id}
                    className="flex items-start gap-3 rounded-md border p-3"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="font-medium truncate">{row.name}</p>
                        <Badge variant="secondary" className="shrink-0 text-[10px]">
                          {CAPEX_CATEGORY_LABELS[row.capex_category] ?? row.capex_category}
                        </Badge>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {row.purchase_date}
                        {row.vendor ? ` · ${row.vendor}` : ''}
                      </p>
                      {row.notes && <p className="text-xs text-muted-foreground mt-1">{row.notes}</p>}
                    </div>
                    <p className="font-semibold tabular-nums shrink-0">{formatZMW(row.amount)}</p>
                    <div className="flex gap-1 shrink-0">
                      <Button variant="ghost" size="icon" onClick={() => openEdit(row)} aria-label="Edit">
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button variant="ghost" size="icon" onClick={() => remove(row)} aria-label="Delete">
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </main>

      <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) resetForm(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? 'Edit CAPEX entry' : 'Add CAPEX entry'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="capex-name">What was purchased</Label>
              <Input
                id="capex-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Delivery van"
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="capex-amount">Amount (ZMW)</Label>
                <Input
                  id="capex-amount"
                  type="number"
                  min="0"
                  step="0.01"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="0.00"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="capex-date">Purchase date</Label>
                <Input
                  id="capex-date"
                  type="date"
                  value={purchaseDate}
                  onChange={(e) => setPurchaseDate(e.target.value)}
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label>Category</Label>
              <Select value={category} onValueChange={setCategory}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {CAPEX_CATEGORIES.map((c) => (
                    <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="capex-vendor">Vendor (optional)</Label>
              <Input
                id="capex-vendor"
                value={vendor}
                onChange={(e) => setVendor(e.target.value)}
                placeholder="Who you bought it from"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="capex-notes">Notes (optional)</Label>
              <Textarea
                id="capex-notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={2}
              />
            </div>

            <p className="text-xs text-muted-foreground">
              CAPEX is a record only. It does not change revenue, cost of sales or profit.
            </p>
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => { setOpen(false); resetForm(); }}>Cancel</Button>
            <Button onClick={save} disabled={saving}>
              {saving ? 'Saving…' : editing ? 'Save changes' : 'Add entry'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default Capex;
