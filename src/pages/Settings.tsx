import { useEffect, useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Building2, Mail, MapPin, Phone, Save, Loader2, Store, Briefcase, Upload, X, Image, Receipt, Hash, Utensils, Archive, Printer, Package, HardHat } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import ConnectionStatus from '@/components/ConnectionStatus';
import LockScreen from '@/components/LockScreen';
import { useAuthContext } from '@/contexts/AuthContext';
import { useBusiness } from '@/hooks/useBusiness';
import { useBusinessType, BusinessType } from '@/hooks/useBusinessType';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { useOnlineStatus } from '@/hooks/useOnlineStatus';
import { generateOfflineId, queuePendingOp } from '@/lib/offlineStorage';
import { getDrawerPin, setDrawerPin, isDrawerAutoOpen, setDrawerAutoOpen, isDesktopApp, openCashDrawer } from '@/lib/cashDrawer';
import CashiersManager from '@/components/CashiersManager';
import DiningTablesManager from '@/components/DiningTablesManager';
import ReceiptModal from '@/components/ReceiptModal';

const RECEIPT_SIZE_KEY = 'zampos.receiptSize';
type ReceiptSizeSetting = '58mm' | '80mm' | 'a4';

const Settings = () => {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { isOnline } = useOnlineStatus();
  const { user, isLoading: authLoading } = useAuthContext();
  const { business, isLoading: bizLoading, refetch, checkSubscriptionStatus } = useBusiness(user?.id);
  const { businessType, setBusinessType, isService, isRestaurant } = useBusinessType(business?.id, business?.businessType);
  const { isLocked } = checkSubscriptionStatus();

  const [saving, setSaving] = useState(false);
  const [businessName, setBusinessName] = useState('');
  const [tpin, setTpin] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [address, setAddress] = useState('');
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Hydrate the form once per business id. A connectivity flap that refetches
  // the same business must not wipe in-progress edits.
  const hydratedBizIdRef = useRef<string | null>(null);

  // Tax config
  const [taxMode, setTaxMode] = useState<'none' | 'vat' | 'custom'>('none');
  const [vatNumber, setVatNumber] = useState('');
  const [vatRate, setVatRate] = useState('16');
  const [customTaxName, setCustomTaxName] = useState('');
  const [customTaxRate, setCustomTaxRate] = useState('');
  const [receiptSize, setReceiptSize] = useState<ReceiptSizeSetting>(() => {
    if (typeof window === 'undefined') return '80mm';
    const saved = window.localStorage.getItem(RECEIPT_SIZE_KEY);
    return saved === '58mm' || saved === '80mm' || saved === 'a4' ? saved : '80mm';
  });

  // Cash drawer (desktop app only)
  const [drawerPin, setDrawerPinState] = useState<number>(() => getDrawerPin());
  const [drawerAutoOpen, setDrawerAutoOpenState] = useState<boolean>(() => isDrawerAutoOpen());
  const [showTestReceipt, setShowTestReceipt] = useState(false);

  // Inventory guard: optimistically true (block negatives) until the row loads.
  const [preventNeg, setPreventNeg] = useState(true);
  const [preventNegSaving, setPreventNegSaving] = useState(false);
  const [capexEnabled, setCapexEnabled] = useState(false);
  const [capexSaving, setCapexSaving] = useState(false);

  const handleDrawerPinChange = (value: string) => {
    const pin = value === '5' ? 5 : 2;
    setDrawerPinState(pin);
    setDrawerPin(pin);
  };

  const handleDrawerAutoOpenChange = (enabled: boolean) => {
    setDrawerAutoOpenState(enabled);
    setDrawerAutoOpen(enabled);
  };

  const handleTestDrawer = () => {
    setDrawerPin(drawerPinState);
    const result = openCashDrawer();
    if (result === 'OK') {
      toast({ title: 'Cash drawer opened', description: 'If it did not move, check the drawer cable and pin number.' });
    } else {
      toast({ variant: 'destructive', title: 'Could not open cash drawer', description: result });
    }
  };

  const handlePreventNegChange = async (enabled: boolean) => {
    if (!business?.id) return;
    const previous = preventNeg;
    setPreventNeg(enabled);
    setPreventNegSaving(true);
    const updates = {
      prevent_negative_stock: enabled,
      updated_at: new Date().toISOString(),
    };
    try {
      if (!isOnline) {
        await queuePendingOp({
          id: generateOfflineId(),
          businessId: business.id,
          type: 'settings_update',
          payload: { updates },
          createdAt: new Date().toISOString(),
        });
        toast({ title: 'Saved offline', description: 'The new stock rule will sync when connected.' });
        return;
      }
      const { error } = await supabase.from('businesses').update(updates).eq('id', business.id);
      if (error) throw error;
      toast({
        title: enabled ? 'Negative stock blocked' : 'Negative stock allowed',
        description: enabled
          ? 'Sales stop once an item runs out.'
          : 'Sales can push an item below zero stock.',
      });
      await refetch();
    } catch (e) {
      setPreventNeg(previous);
      toast({
        variant: 'destructive',
        title: 'Failed',
        description: e instanceof Error ? e.message : 'Could not save this setting',
      });
    } finally {
      setPreventNegSaving(false);
    }
  };

  const handleCapexEnabledChange = async (enabled: boolean) => {
    if (!business?.id) return;
    const previous = capexEnabled;
    setCapexEnabled(enabled);
    setCapexSaving(true);
    const updates = {
      capex_enabled: enabled,
      updated_at: new Date().toISOString(),
    };
    try {
      if (!isOnline) {
        await queuePendingOp({
          id: generateOfflineId(),
          businessId: business.id,
          type: 'settings_update',
          payload: { updates },
          createdAt: new Date().toISOString(),
        });
        toast({ title: 'Saved offline', description: 'The CAPEX setting will sync when connected.' });
        return;
      }
      const { error } = await supabase.from('businesses').update(updates).eq('id', business.id);
      if (error) throw error;
      toast({
        title: enabled ? 'CAPEX turned on' : 'CAPEX turned off',
        description: enabled
          ? 'The CAPEX tab and its report box are now available.'
          : 'The CAPEX tab is hidden. Recorded entries are kept.',
      });
      await refetch();
    } catch (e) {
      setCapexEnabled(previous);
      toast({
        variant: 'destructive',
        title: 'Failed',
        description: e instanceof Error ? e.message : 'Could not save this setting',
      });
    } finally {
      setCapexSaving(false);
    }
  };

  const handleBusinessTypeChange = async (value: BusinessType) => {
    setBusinessType(value);
    if (!business?.id || !isOnline) return;
    try {
      const { error } = await supabase.from('businesses').update({ business_type: value, updated_at: new Date().toISOString() }).eq('id', business.id);
      if (error) throw error;
    } catch (e) {
      // Non-critical: localStorage keeps working, but surface the failure so it
      // isn't silently lost.
      console.error('Failed to save business type:', e);
      toast({
        variant: 'destructive',
        title: 'Business type saved on this device only',
        description: 'Could not reach the server — it will not sync to other devices yet.',
      });
    }
  };

  useEffect(() => {
    window.localStorage.setItem(RECEIPT_SIZE_KEY, receiptSize);
  }, [receiptSize]);

  useEffect(() => {
    if (!authLoading && !user) navigate('/auth');
  }, [authLoading, user, navigate]);

  useEffect(() => {
    if (business && hydratedBizIdRef.current !== business.id) {
      hydratedBizIdRef.current = business.id;
      setBusinessName(business.name || '');
      setTpin(business.tpin || '');
      setPhone(business.phone || '');
      setEmail(business.email || '');
      setAddress(business.address || '');
      setLogoUrl(business.logoUrl || null);
      setTaxMode(business.taxMode || 'none');
      setVatNumber(business.vatNumber || '');
      setVatRate(String(business.vatRate ?? 16));
      setCustomTaxName(business.customTaxName || '');
      setCustomTaxRate(business.customTaxRate != null ? String(business.customTaxRate) : '');
      setPreventNeg(business.preventNegativeStock !== false);
      setCapexEnabled(business.capexEnabled === true);
    }
  }, [business]);

  const handleLogoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !business?.id) return;

    if (!file.type.startsWith('image/')) {
      toast({ variant: 'destructive', title: 'Invalid file', description: 'Please upload an image file.' });
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      toast({ variant: 'destructive', title: 'File too large', description: 'Logo must be under 2MB.' });
      return;
    }

    setUploading(true);
    try {
      const ext = file.name.split('.').pop();
      const path = `${business.id}/logo.${ext}`;

      const { error: uploadErr } = await supabase.storage
        .from('business-logos')
        .upload(path, file, { upsert: true });
      if (uploadErr) throw uploadErr;

      const { data: { publicUrl } } = supabase.storage
        .from('business-logos')
        .getPublicUrl(path);

      const urlWithCacheBust = `${publicUrl}?t=${Date.now()}`;

      await supabase.from('businesses').update({ logo_url: publicUrl, updated_at: new Date().toISOString() }).eq('id', business.id);
      setLogoUrl(urlWithCacheBust);
      toast({ title: 'Logo uploaded', description: 'Your company logo has been saved.' });
      await refetch();
    } catch (err: any) {
      toast({ variant: 'destructive', title: 'Upload failed', description: err?.message ?? 'Could not upload logo' });
    } finally {
      setUploading(false);
    }
  };

  const handleRemoveLogo = async () => {
    if (!business?.id) return;
    setUploading(true);
    try {
      // Try removing all common extensions in parallel
      const exts = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'];
      await Promise.allSettled(exts.map((ext) =>
        supabase.storage.from('business-logos').remove([`${business.id}/logo.${ext}`])
      ));
      await supabase.from('businesses').update({ logo_url: null, updated_at: new Date().toISOString() }).eq('id', business.id);
      setLogoUrl(null);
      toast({ title: 'Logo removed' });
      await refetch();
    } catch (err: any) {
      toast({ variant: 'destructive', title: 'Failed', description: err?.message });
    } finally {
      setUploading(false);
    }
  };

  const handleSave = async () => {
    if (!business?.id) return;

    // Validate TPIN: 10 digits if provided
    const trimmedTpin = tpin.trim();
    if (trimmedTpin && !/^\d{10}$/.test(trimmedTpin)) {
      toast({ variant: 'destructive', title: 'Invalid TPIN', description: 'TPIN must be 10 digits.' });
      return;
    }

    const vatRateNum = parseFloat(vatRate);
    if (taxMode === 'vat' && (!Number.isFinite(vatRateNum) || vatRateNum < 0 || vatRateNum > 100)) {
      toast({ variant: 'destructive', title: 'Invalid VAT rate', description: 'Enter a rate between 0 and 100.' });
      return;
    }

    const customRateNum = parseFloat(customTaxRate);
    if (taxMode === 'custom' && (!Number.isFinite(customRateNum) || customRateNum < 0 || customRateNum > 100)) {
      toast({ variant: 'destructive', title: 'Invalid tax rate', description: 'Enter a rate between 0 and 100.' });
      return;
    }

    setSaving(true);
    try {
      const updates = {
        name: businessName.trim(),
        phone: phone.trim() || null,
        email: email.trim() || null,
        address: address.trim() || null,
        tpin: trimmedTpin || null,
        tax_mode: taxMode,
        vat_number: taxMode === 'vat' ? (vatNumber.trim() || null) : null,
        vat_rate: taxMode === 'vat' ? vatRateNum : 16,
        custom_tax_name: taxMode === 'custom' ? (customTaxName.trim() || 'Tax') : null,
        custom_tax_rate: taxMode === 'custom' ? customRateNum : null,
        updated_at: new Date().toISOString(),
      };

      if (!isOnline) {
        await queuePendingOp({
          id: generateOfflineId(),
          businessId: business.id,
          type: 'settings_update',
          payload: { updates },
          createdAt: new Date().toISOString(),
        });
        toast({ title: 'Settings Saved Offline', description: 'Changes will sync when connected.' });
        return;
      }

      const { error } = await supabase
        .from('businesses')
        .update(updates as any)
        .eq('id', business.id);

      if (error) throw error;

      toast({ title: 'Settings Saved', description: 'Your business details have been updated.' });
      await refetch();
    } catch (e: any) {
      toast({ variant: 'destructive', title: 'Failed', description: e?.message ?? 'Could not save settings' });
    } finally {
      setSaving(false);
    }
  };

  if (authLoading || bizLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <p className="text-muted-foreground">Loading…</p>
      </div>
    );
  }

  if (!business) return null;

  if (isLocked) {
    return (
      <>
        <ConnectionStatus />
        <LockScreen paymentCode={business.paymentCode} businessId={business.id} onRetrySync={refetch} />
      </>
    );
  }

  return (
    <>
      <ConnectionStatus />
      <div className="min-h-screen bg-background safe-area-inset">
        <header className="bg-card border-b border-border px-4 py-4">
          <div className="max-w-4xl mx-auto flex items-center gap-3">
            <Button variant="ghost" size="icon" onClick={() => navigate('/dashboard')} aria-label="Back">
              <ArrowLeft className="h-5 w-5" />
            </Button>
            <div>
              <h1 className="font-display font-bold text-lg flex items-center gap-2">
                <Building2 className="h-5 w-5" /> Business Settings
              </h1>
              <p className="text-xs text-muted-foreground">Update your business profile</p>
            </div>
          </div>
        </header>

        <main className="p-4 max-w-4xl mx-auto space-y-4">
          {/* Business Type Card */}
          <Card>
            <CardHeader>
              <CardTitle>Business Type</CardTitle>
              <CardDescription>
                Choose your business type to customize labels and features.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <RadioGroup
                value={businessType}
                onValueChange={(value) => handleBusinessTypeChange(value as BusinessType)}
                className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4"
              >
                <div className="flex items-center space-x-3 bg-secondary rounded-lg p-4 cursor-pointer hover:bg-secondary/80 transition">
                  <RadioGroupItem value="retail" id="retail" />
                  <Label htmlFor="retail" className="flex items-center gap-2 cursor-pointer flex-1">
                    <Store className="h-5 w-5 text-primary" />
                    <div>
                      <p className="font-medium">Retail / Shop</p>
                      <p className="text-xs text-muted-foreground">Products, stock tracking, inventory</p>
                    </div>
                  </Label>
                </div>
                <div className="flex items-center space-x-3 bg-secondary rounded-lg p-4 cursor-pointer hover:bg-secondary/80 transition">
                  <RadioGroupItem value="service" id="service" />
                  <Label htmlFor="service" className="flex items-center gap-2 cursor-pointer flex-1">
                    <Briefcase className="h-5 w-5 text-primary" />
                    <div>
                      <p className="font-medium">Service-Based</p>
                      <p className="text-xs text-muted-foreground">Salons, mechanics, tutors, consultants</p>
                    </div>
                  </Label>
                </div>
                <div className="flex items-center space-x-3 bg-secondary rounded-lg p-4 cursor-pointer hover:bg-secondary/80 transition">
                  <RadioGroupItem value="hybrid" id="hybrid" />
                  <Label htmlFor="hybrid" className="flex items-center gap-2 cursor-pointer flex-1">
                    <div className="flex -space-x-1">
                      <Store className="h-5 w-5 text-primary" />
                      <Briefcase className="h-5 w-5 text-primary" />
                    </div>
                    <div>
                      <p className="font-medium">Both (Hybrid)</p>
                      <p className="text-xs text-muted-foreground">Sell products and services together</p>
                    </div>
                  </Label>
                </div>
                <div className="flex items-center space-x-3 bg-secondary rounded-lg p-4 cursor-pointer hover:bg-secondary/80 transition">
                  <RadioGroupItem value="restaurant" id="restaurant" />
                  <Label htmlFor="restaurant" className="flex items-center gap-2 cursor-pointer flex-1">
                    <Utensils className="h-5 w-5 text-primary" />
                    <div>
                      <p className="font-medium">Restaurant / Food</p>
                      <p className="text-xs text-muted-foreground">Menu, orders, kitchen & tables</p>
                    </div>
                  </Label>
                </div>
              </RadioGroup>
            </CardContent>
          </Card>

          {/* Company Logo Card */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><Image className="h-5 w-5" /> Company Logo</CardTitle>
              <CardDescription>
                Upload your company logo. It will appear on quotations and receipts.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-6">
                <div className="w-24 h-24 rounded-lg border-2 border-dashed border-border flex items-center justify-center overflow-hidden bg-muted/50 shrink-0">
                  {logoUrl ? (
                    <img src={logoUrl} alt="Company logo" className="w-full h-full object-contain" />
                  ) : (
                    <Image className="h-8 w-8 text-muted-foreground" />
                  )}
                </div>
                <div className="space-y-2">
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    onChange={handleLogoUpload}
                    className="hidden"
                  />
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={uploading}
                    >
                      {uploading ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Upload className="h-4 w-4 mr-1" />}
                      {logoUrl ? 'Change' : 'Upload'}
                    </Button>
                    {logoUrl && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={handleRemoveLogo}
                        disabled={uploading}
                      >
                        <X className="h-4 w-4 mr-1" /> Remove
                      </Button>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">PNG, JPG, or SVG. Max 2MB.</p>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Business Profile Card */}
          <Card>
            <CardHeader>
              <CardTitle>Business Profile</CardTitle>
              <CardDescription>
                This information will appear on your receipts and is visible to support staff.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="business-name">Business Name</Label>
                <div className="relative">
                  <Building2 className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    id="business-name"
                    type="text"
                    placeholder={isService ? "My Salon" : "My Shop"}
                    className="pl-10"
                    value={businessName}
                    onChange={(e) => setBusinessName(e.target.value)}
                    required
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="business-phone">Phone Number</Label>
                <div className="relative">
                  <Phone className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    id="business-phone"
                    type="tel"
                    placeholder="+260 97 123 4567"
                    className="pl-10"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="business-email">Business Email</Label>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    id="business-email"
                    type="email"
                    placeholder={isService ? "salon@example.com" : "shop@example.com"}
                    className="pl-10"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="business-address">Address</Label>
                <div className="relative">
                  <MapPin className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    id="business-address"
                    type="text"
                    placeholder="123 Main Street, Lusaka"
                    className="pl-10"
                    value={address}
                    onChange={(e) => setAddress(e.target.value)}
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="business-tpin">TPIN (Tax Payer Identification Number)</Label>
                <div className="relative">
                  <Hash className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    id="business-tpin"
                    type="text"
                    inputMode="numeric"
                    maxLength={10}
                    placeholder="10-digit TPIN (optional)"
                    className="pl-10"
                    value={tpin}
                    onChange={(e) => setTpin(e.target.value.replace(/\D/g, ''))}
                  />
                </div>
                <p className="text-xs text-muted-foreground">Shown on receipts, quotations and invoices.</p>
              </div>
            </CardContent>
          </Card>

          {/* Receipt Printing */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><Receipt className="h-5 w-5" /> Receipt Printing</CardTitle>
              <CardDescription>
                Default paper size used when printing sales receipts.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              <Label>Default receipt size</Label>
              <Select value={receiptSize} onValueChange={(value) => setReceiptSize(value as ReceiptSizeSetting)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="58mm">58mm thermal printer</SelectItem>
                  <SelectItem value="80mm">80mm thermal printer</SelectItem>
                  <SelectItem value="a4">A4 office printer</SelectItem>
                </SelectContent>
              </Select>
              <Button variant="outline" className="w-full" onClick={() => setShowTestReceipt(true)}>
                <Printer className="mr-2 h-4 w-4" /> Test print
              </Button>
              <p className="text-xs text-muted-foreground">
                Opens a sample receipt so you can confirm the paper size matches your printer before taking a sale.
              </p>
            </CardContent>
          </Card>

          {/* Cash Drawer — desktop app only: the browser cannot drive the printer. */}
          {isDesktopApp() && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><Archive className="h-5 w-5" /> Cash Drawer</CardTitle>
                <CardDescription>
                  Opens the drawer when a cash sale is completed. The drawer plugs into the
                  printer's RJ11 port, not the computer.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center justify-between gap-4 rounded-lg bg-secondary p-3">
                  <div>
                    <Label htmlFor="drawer-auto-open">Open on cash sales</Label>
                    <p className="text-xs text-muted-foreground">Kicks the drawer after a cash payment.</p>
                  </div>
                  <Switch
                    id="drawer-auto-open"
                    checked={drawerAutoOpen}
                    onCheckedChange={handleDrawerAutoOpenChange}
                  />
                </div>

                <div className="space-y-2">
                  <Label>Drawer kick pin</Label>
                  <Select value={String(drawerPin)} onValueChange={handleDrawerPinChange}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="2">Pin 2 (most common)</SelectItem>
                      <SelectItem value="5">Pin 5</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">Try pin 2 first. If the drawer does not open, switch to pin 5.</p>
                </div>

                <Button variant="outline" onClick={handleTestDrawer}>
                  Test cash drawer
                </Button>
              </CardContent>
            </Card>
          )}

          {/* Inventory */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><Package className="h-5 w-5" /> Inventory</CardTitle>
              <CardDescription>
                Decides what happens when a sale would take stock below zero.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between gap-4 rounded-lg bg-secondary p-3">
                <div>
                  <Label htmlFor="prevent-negative-stock">Prevent negative inventory</Label>
                  <p className="text-xs text-muted-foreground">
                    {preventNeg
                      ? 'ON — a sale stops once an item runs out.'
                      : 'OFF — stock may be pushed below zero.'}
                  </p>
                </div>
                <Switch
                  id="prevent-negative-stock"
                  checked={preventNeg}
                  disabled={preventNegSaving}
                  onCheckedChange={handlePreventNegChange}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                On by default for every business. Turn it off only if you deliberately sell items
                you have not received yet.
              </p>
            </CardContent>
          </Card>

          {/* CAPEX */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><HardHat className="h-5 w-5" /> CAPEX</CardTitle>
              <CardDescription>
                Keeps capital purchases — vans, machines, fittings — in their own register, separate
                from your running expenses.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between gap-4 rounded-lg bg-secondary p-3">
                <div>
                  <Label htmlFor="capex-enabled">Show the CAPEX register</Label>
                  <p className="text-xs text-muted-foreground">
                    {capexEnabled
                      ? 'ON — a CAPEX tab and a CAPEX box in Reports.'
                      : 'OFF — hidden. Anything already recorded is kept.'}
                  </p>
                </div>
                <Switch
                  id="capex-enabled"
                  checked={capexEnabled}
                  disabled={capexSaving}
                  onCheckedChange={handleCapexEnabledChange}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                CAPEX is a record only. It never changes your revenue, cost of sales or profit.
              </p>
            </CardContent>
          </Card>

          {/* Tax Configuration */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><Receipt className="h-5 w-5" /> Tax Configuration</CardTitle>
              <CardDescription>
                Choose how tax is applied. VAT is only added when enabled here.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <RadioGroup value={taxMode} onValueChange={(v) => setTaxMode(v as 'none' | 'vat' | 'custom')} className="space-y-2">
                <div className="flex items-start gap-3 bg-secondary rounded-lg p-3">
                  <RadioGroupItem value="none" id="tax-none" className="mt-1" />
                  <Label htmlFor="tax-none" className="flex-1 cursor-pointer">
                    <p className="font-medium">No Tax</p>
                    <p className="text-xs text-muted-foreground">Prices are final. No VAT line on receipts.</p>
                  </Label>
                </div>
                <div className="flex items-start gap-3 bg-secondary rounded-lg p-3">
                  <RadioGroupItem value="vat" id="tax-vat" className="mt-1" />
                  <Label htmlFor="tax-vat" className="flex-1 cursor-pointer">
                    <p className="font-medium">VAT Registered</p>
                    <p className="text-xs text-muted-foreground">Standard Zambian VAT (default 16%). Prices treated as VAT-inclusive.</p>
                  </Label>
                </div>
                <div className="flex items-start gap-3 bg-secondary rounded-lg p-3">
                  <RadioGroupItem value="custom" id="tax-custom" className="mt-1" />
                  <Label htmlFor="tax-custom" className="flex-1 cursor-pointer">
                    <p className="font-medium">Custom Tax</p>
                    <p className="text-xs text-muted-foreground">Set your own tax name & rate (e.g. service charge, tourism levy).</p>
                  </Label>
                </div>
              </RadioGroup>

              {taxMode === 'vat' && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2 border-t">
                  <div className="space-y-2">
                    <Label>VAT Number (optional)</Label>
                    <Input value={vatNumber} onChange={(e) => setVatNumber(e.target.value)} placeholder="ZRA VAT registration #" />
                  </div>
                  <div className="space-y-2">
                    <Label>VAT Rate (%)</Label>
                    <Input type="number" min="0" max="100" step="0.01" value={vatRate} onChange={(e) => setVatRate(e.target.value)} />
                  </div>
                </div>
              )}

              {taxMode === 'custom' && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2 border-t">
                  <div className="space-y-2">
                    <Label>Tax Name</Label>
                    <Input value={customTaxName} onChange={(e) => setCustomTaxName(e.target.value)} placeholder="e.g. Service Tax" />
                  </div>
                  <div className="space-y-2">
                    <Label>Tax Rate (%)</Label>
                    <Input type="number" min="0" max="100" step="0.01" value={customTaxRate} onChange={(e) => setCustomTaxRate(e.target.value)} placeholder="e.g. 5" />
                  </div>
                </div>
              )}

              <Button
                variant="pos"
                className="w-full"
                onClick={handleSave}
                disabled={saving}
              >
                {saving ? (
                  <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Saving...</>
                ) : (
                  <><Save className="mr-2 h-4 w-4" /> Save Changes</>
                )}
              </Button>
            </CardContent>
          </Card>

          {/* Dining Tables (restaurant only) */}
          {isRestaurant && business?.id ? (
            <DiningTablesManager businessId={business.id} />
          ) : null}

          {/* Cashiers */}
          {business?.id ? (
            <CashiersManager businessId={business.id} paymentCode={business.paymentCode} planTier={business.planTier} isRestaurant={isRestaurant} />
          ) : null}
        </main>

        <ReceiptModal
          open={showTestReceipt}
          onClose={() => setShowTestReceipt(false)}
          businessName={businessName || 'Your Business'}
          businessDetails={{ phone, email, address, tpin }}
          items={[
            { name: 'Sample item A', price: 25, quantity: 2 },
            { name: 'Sample item B', price: 12.5, quantity: 1 },
          ]}
          subtotal={62.5}
          total={62.5}
          paymentMethod="cash"
          date={new Date().toISOString()}
          receiptId="TEST-PRINT"
        />
      </div>
    </>
  );
};

export default Settings;
