import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';

export interface Affiliate {
  id: string;
  user_id: string;
  affiliate_code: string;
  status: 'pending' | 'active' | 'suspended';
  total_earnings: number;
  created_at: string;
  updated_at: string;
  full_name?: string | null;
  phone?: string | null;
  payout_method?: string | null;
  payout_number?: string | null;
  payout_name?: string | null;
}

export interface AffiliateReferral {
  id: string;
  affiliate_id: string;
  business_id: string;
  created_at: string;
  business?: {
    id: string;
    name: string;
    subscription_status: 'trial' | 'active' | 'expired' | 'locked';
    created_at: string;
  };
}

export interface AffiliateCommission {
  id: string;
  affiliate_id: string;
  referral_id: string;
  amount: number;
  commission_month: string;
  status: 'pending' | 'paid';
  paid_at: string | null;
  created_at: string;
}

export interface AffiliateStats {
  totalReferrals: number;
  activeClients: number;
  pendingCommission: number;
  totalEarnings: number;
}

export const useAffiliate = (userId?: string) => {
  const [affiliate, setAffiliate] = useState<Affiliate | null>(null);
  const [referrals, setReferrals] = useState<AffiliateReferral[]>([]);
  const [commissions, setCommissions] = useState<AffiliateCommission[]>([]);
  const [stats, setStats] = useState<AffiliateStats>({
    totalReferrals: 0,
    activeClients: 0,
    pendingCommission: 0,
    totalEarnings: 0,
  });
  const [isLoading, setIsLoading] = useState(true);

  const fetchAffiliate = useCallback(async () => {
    if (!userId) {
      setIsLoading(false);
      return;
    }

    try {
      // Fetch affiliate profile
      const { data: affData, error: affErr } = await supabase
        .from('affiliates')
        .select('*')
        .eq('user_id', userId)
        .maybeSingle();

      if (affErr) throw affErr;

      if (affData) {
        setAffiliate(affData as Affiliate);

        // Fetch referrals
        const { data: refData, error: refErr } = await supabase
          .from('affiliate_referrals')
          .select('id, affiliate_id, business_id, created_at')
          .eq('affiliate_id', affData.id);

        if (refErr) throw refErr;

        // Fetch limited business info via security-restricted view
        const businessIds = (refData || []).map((r: any) => r.business_id);
        const businessMap: Record<string, any> = {};
        if (businessIds.length > 0) {
          const { data: bizData } = await (supabase as any)
            .from('affiliate_referred_businesses')
            .select('id, name, subscription_status, created_at')
            .in('id', businessIds);
          (bizData || []).forEach((b: any) => { businessMap[b.id] = b; });
        }

        const mappedReferrals: AffiliateReferral[] = (refData || []).map((r: any) => ({
          id: r.id,
          affiliate_id: r.affiliate_id,
          business_id: r.business_id,
          created_at: r.created_at,
          business: businessMap[r.business_id] || null,
        }));
        setReferrals(mappedReferrals);

        // Fetch commissions
        const { data: commData, error: commErr } = await supabase
          .from('affiliate_commissions')
          .select('*')
          .eq('affiliate_id', affData.id)
          .order('commission_month', { ascending: false });

        if (commErr) throw commErr;
        setCommissions((commData || []) as AffiliateCommission[]);

        // Calculate stats
        const activeClients = mappedReferrals.filter(r => r.business?.subscription_status === 'active').length;
        const pendingCommission = (commData || [])
          .filter((c: any) => c.status === 'pending')
          .reduce((sum: number, c: any) => sum + Number(c.amount), 0);

        setStats({
          totalReferrals: mappedReferrals.length,
          activeClients,
          pendingCommission,
          totalEarnings: Number(affData.total_earnings),
        });
      }
    } catch (e) {
      console.error('Error fetching affiliate data:', e);
    } finally {
      setIsLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    fetchAffiliate();
  }, [fetchAffiliate]);

  const becomeAffiliate = async () => {
    if (!userId) return { error: new Error('Not authenticated') };

    try {
      // Generate affiliate code using the database function
      const { data: codeData, error: codeErr } = await supabase
        .rpc('generate_affiliate_code');

      if (codeErr) throw codeErr;

      const { error } = await supabase
        .from('affiliates')
        .insert({
          user_id: userId,
          affiliate_code: codeData,
          status: 'active',
        });

      if (error) throw error;
      
      await fetchAffiliate();
      return { error: null };
    } catch (e: any) {
      return { error: e };
    }
  };

  const updateAffiliate = async (updates: Partial<Pick<Affiliate, 'full_name' | 'phone' | 'payout_method' | 'payout_number' | 'payout_name'>>) => {
    if (!userId || !affiliate) return { error: new Error('Affiliate not found') };

    try {
      const payload: {
        full_name?: string | null;
        phone?: string | null;
        payout_method?: string | null;
        payout_number?: string | null;
        payout_name?: string | null;
      } = {};
      if (updates.full_name !== undefined) payload.full_name = updates.full_name?.trim() || null;
      if (updates.phone !== undefined) payload.phone = updates.phone?.trim() || null;
      if (updates.payout_method !== undefined) payload.payout_method = updates.payout_method || null;
      if (updates.payout_number !== undefined) payload.payout_number = updates.payout_number?.trim() || null;
      if (updates.payout_name !== undefined) payload.payout_name = updates.payout_name?.trim() || null;

      const { error } = await supabase
        .from('affiliates')
        .update(payload)
        .eq('id', affiliate.id);

      if (error) throw error;

      await fetchAffiliate();
      return { error: null };
    } catch (e: any) {
      return { error: e };
    }
  };

  const getReferralLink = () => {
    if (!affiliate) return '';
    return `${window.location.origin}/auth?ref=${affiliate.affiliate_code}`;
  };

  return {
    affiliate,
    referrals,
    commissions,
    stats,
    isLoading,
    becomeAffiliate,
    updateAffiliate,
    getReferralLink,
    refetch: fetchAffiliate,
  };
};

// Utility to validate affiliate code during registration
export const validateAffiliateCode = async (code: string): Promise<string | null> => {
  if (!code.trim()) return null;

  try {
    const { data, error } = await supabase
      .rpc('get_affiliate_by_code', { code: code.trim().toUpperCase() });

    if (error) {
      console.error('Error validating affiliate code:', error);
      return null;
    }

    return data as string | null;
  } catch (e) {
    console.error('Error validating affiliate code:', e);
    return null;
  }
};
