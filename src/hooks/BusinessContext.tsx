import React, {
  createContext,
  useContext,
  useEffect,
  useCallback,
  useRef,
  useState,
  ReactNode,
  useMemo,
} from 'react';
import { supabase } from '@/integrations/supabase/client';
import {
  cacheSubscription,
  getCachedSubscription,
  cacheServerTime,
  getAdjustedTime,
  isOfflineTooLong,
  cacheBusiness,
  getCachedBusiness,
} from '@/lib/offlineStorage';
import { useOnlineStatus } from './useOnlineStatus';
import { useAuthContext } from '@/contexts/AuthContext';
import type { Database } from '@/integrations/supabase/types';

type BusinessRow = Database['public']['Tables']['businesses']['Row'];

export interface Business {
  id: string;
  name: string;
  paymentCode: string;
  subscriptionStatus: 'trial' | 'active' | 'expired' | 'locked';
  subscriptionExpiresAt: Date | null;
  isLocked: boolean;
  lastSyncAt: Date;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  logoUrl?: string | null;
  tpin?: string | null;
  taxMode: 'none' | 'vat' | 'custom';
  vatNumber?: string | null;
  vatRate: number;
  customTaxName?: string | null;
  customTaxRate?: number | null;
  planTier?: string | null;
  businessType?: string | null;
  /** Opt-in flag. Absent/undefined must be treated as `true` (block negatives). */
  preventNegativeStock: boolean;
}

export interface BusinessGroupEntry {
  id: string;
  name: string;
  paymentCode: string;
  businessType: string;
  parentBusinessId: string | null;
  subscriptionStatus: Database['public']['Enums']['subscription_status'];
  isLocked: boolean;
  branchKind: 'root' | 'branch';
}

interface BusinessContextValue {
  business: Business | null;
  businesses: BusinessGroupEntry[];
  isMultiBranch: boolean;
  rootBusinessId: string | null;
  isLoading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
  checkSubscriptionStatus: () => { isExpired: boolean; isLocked: boolean; daysRemaining: number };
  switchBranch: (businessId: string) => Promise<void>;
  createBranch: (name: string, businessType?: string) => Promise<string | null>;
  refreshGroup: () => Promise<void>;
}

const mapBusinessRow = (row: BusinessRow): Business => ({
  id: row.id,
  name: row.name,
  paymentCode: row.payment_code,
  subscriptionStatus: row.subscription_status as Business['subscriptionStatus'],
  subscriptionExpiresAt: row.subscription_expires_at ? new Date(row.subscription_expires_at) : null,
  isLocked: row.is_locked,
  lastSyncAt: new Date(row.last_sync_at ?? new Date().toISOString()),
  phone: row.phone,
  email: row.email,
  address: row.address,
  logoUrl: row.logo_url,
  tpin: row.tpin,
  taxMode: (row.tax_mode ?? 'none') as Business['taxMode'],
  vatNumber: row.vat_number,
  vatRate: Number(row.vat_rate ?? 16),
  customTaxName: row.custom_tax_name,
  customTaxRate: row.custom_tax_rate != null ? Number(row.custom_tax_rate) : null,
  planTier: (row as unknown as Record<string, unknown>).plan_tier
    ? String((row as unknown as Record<string, unknown>).plan_tier)
    : null,
  businessType: row.business_type ?? null,
  preventNegativeStock: (row as unknown as Record<string, unknown>).prevent_negative_stock !== false,
});

const isElectronBiz = typeof navigator !== 'undefined' && navigator.userAgent?.includes('Electron');
const BUSINESS_LOADING_TIMEOUT_MS = isElectronBiz ? 5_000 : 20_000;

const BusinessContext = createContext<BusinessContextValue | undefined>(undefined);

export const BusinessProvider = ({ children }: { children: ReactNode }) => {
  const { user, isLoading: authLoading } = useAuthContext();

  const [business, setBusiness] = useState<Business | null>(null);
  const businessRef = useRef<Business | null>(null);
  businessRef.current = business;
  const [businesses, setBusinesses] = useState<BusinessGroupEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { isOnline } = useOnlineStatus();
  const loadingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep track of which business the user is "on" — switching branches changes
  // this id and re-loads the matching row. Always lands on the root (head office).
  const rootBusinessIdRef = useRef<string | null>(null);
  const [rootBusinessId, setRootBusinessId] = useState<string | null>(null);

  const clearLoadingTimer = useCallback(() => {
    if (loadingTimerRef.current) {
      clearTimeout(loadingTimerRef.current);
      loadingTimerRef.current = null;
    }
  }, []);

  const startLoadingTimer = useCallback(() => {
    clearLoadingTimer();
    loadingTimerRef.current = setTimeout(() => {
      loadingTimerRef.current = null;
      console.warn('[useBusiness] Loading timed out after 20s — forcing ready state');
      setIsLoading(false);
    }, BUSINESS_LOADING_TIMEOUT_MS);
  }, [clearLoadingTimer]);

  // --- subscription / cache helpers (ported from useBusiness) ---
  const persistBusinessCache = useCallback(async (row: BusinessRow) => {
    cacheSubscription({
      expiresAt: row.subscription_expires_at || '',
      status: row.subscription_status,
      lastSyncAt: new Date().toISOString(),
      isLocked: row.is_locked,
    });
    await cacheBusiness({
      id: row.id,
      name: row.name,
      paymentCode: row.payment_code,
      subscriptionStatus: row.subscription_status,
      subscriptionExpiresAt: row.subscription_expires_at,
      isLocked: row.is_locked,
      lastSyncAt: row.last_sync_at ?? new Date().toISOString(),
      phone: row.phone,
      email: row.email,
      address: row.address,
      taxMode: (row.tax_mode ?? 'none') as Business['taxMode'],
      vatRate: Number(row.vat_rate ?? 16),
      customTaxName: row.custom_tax_name,
      customTaxRate: row.custom_tax_rate != null ? Number(row.custom_tax_rate) : null,
      tpin: row.tpin,
      logoUrl: row.logo_url,
      vatNumber: row.vat_number,
      businessType: row.business_type ?? null,
      preventNegativeStock: (row as unknown as Record<string, unknown>).prevent_negative_stock !== false,
    }, user?.id);
  }, [user?.id]);

  const loadCachedBusiness = useCallback(async () => {
    const cachedBiz = await getCachedBusiness(user?.id);
    if (cachedBiz) {
      const now = getAdjustedTime();
      const expiry = cachedBiz.subscriptionExpiresAt ? new Date(cachedBiz.subscriptionExpiresAt) : null;
      const isExpiredOffline = expiry ? now >= expiry : true;
      setBusiness({
        id: cachedBiz.id,
        name: cachedBiz.name,
        paymentCode: cachedBiz.paymentCode,
        subscriptionStatus: isExpiredOffline ? 'expired' : (cachedBiz.subscriptionStatus as Business['subscriptionStatus']),
        subscriptionExpiresAt: expiry,
        isLocked: isExpiredOffline || cachedBiz.isLocked,
        lastSyncAt: new Date(cachedBiz.lastSyncAt),
        phone: cachedBiz.phone,
        email: cachedBiz.email,
        address: cachedBiz.address,
        taxMode: (cachedBiz.taxMode ?? 'none') as Business['taxMode'],
        vatRate: cachedBiz.vatRate ?? 16,
        customTaxName: cachedBiz.customTaxName ?? null,
        customTaxRate: cachedBiz.customTaxRate ?? null,
        tpin: cachedBiz.tpin ?? null,
        logoUrl: cachedBiz.logoUrl ?? null,
        vatNumber: cachedBiz.vatNumber ?? null,
        businessType: cachedBiz.businessType ?? null,
        preventNegativeStock: cachedBiz.preventNegativeStock !== false,
      });
      return;
    }
    const cached = getCachedSubscription();
    if (!cached) return;
    const now = getAdjustedTime();
    const expiry = cached.expiresAt ? new Date(cached.expiresAt) : null;
    const isExpiredOffline = expiry ? now >= expiry : true;
    setBusiness({
      id: '',
      name: 'Offline Mode',
      paymentCode: '',
      subscriptionStatus: isExpiredOffline ? 'expired' : (cached.status as Business['subscriptionStatus']),
      subscriptionExpiresAt: expiry,
      isLocked: isExpiredOffline || cached.isLocked,
      lastSyncAt: new Date(cached.lastSyncAt),
      taxMode: 'none',
      vatRate: 16,
      // No cached business row at all -> fail closed (match today's behaviour).
      preventNegativeStock: true,
    });
  }, [user?.id]);

  const updateSubscriptionStatusInDB = useCallback(
    async (bizId: string, currentStatus: string, expiresAt: string | null) => {
      if (!isOnline) return false;
      const now = new Date();
      const isDue = !expiresAt || now.getTime() >= new Date(expiresAt).getTime();
      if (!isDue || currentStatus === 'expired' || currentStatus === 'locked') return false;
      const { data, error } = await supabase.rpc('expire_business_if_due', { _business_id: bizId });
      if (error) {
        console.warn('expire_business_if_due failed:', error);
        return false;
      }
      return !!data;
    },
    [isOnline]
  );

  // Load a single business row into the active business state.
  const loadBusinessRow = useCallback(
    async (bizId: string) => {
      const { data, error: fetchError } = await supabase
        .from('businesses')
        .select('*')
        .eq('id', bizId)
        .maybeSingle();
      if (fetchError) return null;
      if (!data) return null;

      const wasUpdated = await updateSubscriptionStatusInDB(
        data.id,
        data.subscription_status,
        data.subscription_expires_at
      );
      const row = wasUpdated
        ? (await supabase.from('businesses').select('*').eq('id', data.id).maybeSingle()).data ?? data
        : data;

      setBusiness(mapBusinessRow(row));
      await persistBusinessCache(row);

      let touched: { updated_at: string | null } | null = null;
      try {
        const result = await supabase
          .from('businesses')
          .update({ last_sync_at: new Date().toISOString() })
          .eq('id', data.id)
          .select('updated_at')
          .single();
        touched = result.data as { updated_at: string | null } | null;
      } catch {
        // non-critical
      }
      const parseTimestamp = (value: string | null | undefined): Date | null => {
        if (!value) return null;
        const normalized = value.includes('T') ? value : value.replace(' ', 'T');
        const parsed = new Date(normalized);
        return Number.isNaN(parsed.getTime()) ? null : parsed;
      };
      const serverTime =
        parseTimestamp(touched?.updated_at) ??
        parseTimestamp(data.updated_at) ??
        new Date();
      cacheServerTime(serverTime);
      return row;
    },
    [updateSubscriptionStatusInDB, persistBusinessCache]
  );

  // Load the owner's group and return the list + the root id.
  const loadGroup = useCallback(async (userId: string): Promise<{ rows: BusinessGroupEntry[]; rootId: string | null } | null> => {
    const { data, error } = await supabase.rpc('get_my_business_group');
    if (error || !data) return null;
    const rows = (data as unknown as Array<Record<string, unknown>>).map((g) => ({
      id: g.id as string,
      name: g.name as string,
      paymentCode: g.payment_code as string,
      businessType: g.business_type as string,
      parentBusinessId: g.parent_business_id as string | null,
      subscriptionStatus: g.subscription_status as BusinessGroupEntry['subscriptionStatus'],
      isLocked: g.is_locked as boolean,
      branchKind: g.branch_kind as 'root' | 'branch',
    }));
    const root = rows.find((r) => r.branchKind === 'root');
    return { rows, rootId: root ? root.id : rows.length ? rows[0].id : null };
  }, []);

  const fetchAll = useCallback(
    async (targetId?: string) => {
      const uid = user?.id;
      if (!uid) {
        setBusiness(null);
        setBusinesses([]);
        setIsLoading(false);
        return;
      }

      setBusiness((prev) => {
        if (!prev) {
          setIsLoading(true);
          startLoadingTimer();
        }
        return prev;
      });
      setError(null);

      try {
        if (!isOnline) {
          await loadCachedBusiness();
          return;
        }

        // Load group (also works for single business — returns just that row).
        const group = await loadGroup(uid);
        if (group) {
          setBusinesses(group.rows);
          rootBusinessIdRef.current = group.rootId;
          setRootBusinessId(group.rootId);
        }

        // Decide which business to show.
        let activeId: string | null = targetId ?? null;
        if (!activeId) {
          // Resolve default: owner's root first; fall back to get_my_business_id
          activeId = rootBusinessIdRef.current;
        }
        if (!activeId) {
          const { data: bizId } = await supabase.rpc('get_my_business_id');
          activeId = (bizId as string) ?? null;
        }
        if (!activeId) {
          // No business could be resolved from the server (unreachable, or
          // this account genuinely has none). Fall back to the cached business
          // so a dead or flaky connection can never blank out a perfectly good
          // local session. If nothing is cached either, business stays null.
          await loadCachedBusiness();
          return;
        }

        await loadBusinessRow(activeId);
      } catch (err: unknown) {
        console.error('Error fetching business:', err);
        const msg = err instanceof Error ? err.message : 'Failed to load business data';
        setError(msg);
        await loadCachedBusiness();
      } finally {
        clearLoadingTimer();
        setIsLoading(false);
      }
    },
    [user?.id, isOnline, loadCachedBusiness, loadGroup, loadBusinessRow, startLoadingTimer, clearLoadingTimer]
  );

  // --- Branch switching ---
  const switchBranch = useCallback(
    async (businessId: string) => {
      const target = businesses.find((b) => b.id === businessId);
      if (!target) return;
      // Load the branch row in the background; don't flip global loading (would
      // unmount open dialogs). Keep showing current content until ready.
      setError(null);
      await loadBusinessRow(businessId);
      // Pass the target id in the payload so the listener refetches the NEW
      // branch — reading businessRef here would still hold the stale branch
      // (React hasn't committed the state update yet) and snap the UI back.
      window.dispatchEvent(new CustomEvent('zampos:business-changed', { detail: { businessId } }));
    },
    [businesses, loadBusinessRow]
  );

  const refreshGroup = useCallback(async () => {
    const uid = user?.id;
    if (!uid || !isOnline) return;
    const group = await loadGroup(uid);
    if (group) {
      setBusinesses(group.rows);
      rootBusinessIdRef.current = group.rootId;
      setRootBusinessId(group.rootId);
    }
  }, [user?.id, isOnline, loadGroup]);

  const createBranch = useCallback(
    async (name: string, businessType?: string): Promise<string | null> => {
      const parentId = rootBusinessId ?? business?.id;
      if (!parentId) return null;
      const { data, error } = await supabase.rpc('create_branch', {
        p_parent_id: parentId,
        p_name: name,
        p_business_type: businessType ?? 'retail',
      });
      if (error) {
        console.error('create_branch failed:', error);
        return null;
      }
      await refreshGroup();
      return (data as string) ?? null;
    },
    [rootBusinessId, business?.id, refreshGroup]
  );

  const checkSubscriptionStatus = useCallback((): { isExpired: boolean; isLocked: boolean; daysRemaining: number } => {
    if (!business) {
      return { isExpired: false, isLocked: false, daysRemaining: 0 };
    }
    if (isOfflineTooLong(35)) {
      return { isExpired: true, isLocked: true, daysRemaining: 0 };
    }
    const now = getAdjustedTime();
    const expiresAt = business.subscriptionExpiresAt;
    if (!expiresAt || isNaN(expiresAt.getTime()) || isNaN(now.getTime())) {
      return { isExpired: true, isLocked: true, daysRemaining: 0 };
    }
    const isExpired = now >= expiresAt;
    const daysRemaining = Math.max(0, Math.ceil((expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)));
    return {
      isExpired,
      isLocked: business.isLocked || isExpired,
      daysRemaining,
    };
  }, [business]);

  // Initial load + when user changes
  useEffect(() => {
    if (authLoading) return;
    void fetchAll();
    return () => clearLoadingTimer();
  }, [fetchAll, authLoading, clearLoadingTimer]);

  // Realtime business changes -> refetch the active branch so an external
  // update invalidates the row without resetting the user back to the root.
  useEffect(() => {
    if (!isOnline) return;
    const handler = (evt: Event) => {
      const detail = (evt as CustomEvent<{ businessId?: string }>).detail;
      const current = businessRef.current;
      void fetchAll(detail?.businessId ?? current?.id);
    };
    window.addEventListener('zampos:business-changed', handler);
    return () => window.removeEventListener('zampos:business-changed', handler);
  }, [fetchAll, isOnline]);

  const isMultiBranch = businesses.length > 1;

  const value = useMemo<BusinessContextValue>(
    () => ({
      business,
      businesses,
      isMultiBranch,
      rootBusinessId,
      isLoading,
      error,
      refetch: () => fetchAll(businessRef.current?.id),
      checkSubscriptionStatus,
      switchBranch,
      createBranch,
      refreshGroup,
    }),
    [
      business,
      businesses,
      isMultiBranch,
      rootBusinessId,
      isLoading,
      error,
      fetchAll,
      checkSubscriptionStatus,
      switchBranch,
      createBranch,
      refreshGroup,
    ]
  );

  return <BusinessContext.Provider value={value}>{children}</BusinessContext.Provider>;
};

export const useBusinessContext = () => {
  const context = useContext(BusinessContext);
  if (context === undefined) {
    throw new Error('useBusinessContext must be used within a BusinessProvider');
  }
  return context;
};
