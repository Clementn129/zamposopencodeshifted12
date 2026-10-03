import { useState, useEffect, useCallback, useRef } from 'react';
import { User, Session } from '@supabase/supabase-js';
import { supabase } from '@/integrations/supabase/client';
import {
  persistOfflineSession,
  readOfflineSessionRecord,
  clearOfflineSession,
  type OfflineSessionRecord,
} from '@/lib/offlineStorage';

const isElectron = typeof navigator !== 'undefined' && navigator.userAgent?.includes('Electron');
const LOADING_TIMEOUT_MS = isElectron ? 3_000 : 15_000;
const ROLE_CACHE_PREFIX = 'zampos:role:';

/** Maximum time to spend trying to recover a lost session before giving up
 *  and redirecting to login. Prevents the app from hanging forever if
 *  getSession / refreshSession stall on slow or flaky networks. */
const RECOVERY_TIMEOUT_MS = 10_000;

/** Rebuilds the in-memory session used by offline logins (there is no real
 *  Supabase session to restore, so the record in localStorage is the source
 *  of truth until it expires or the user signs out). */
const buildOfflineSession = (record: OfflineSessionRecord): Session => {
  const mockUser = {
    id: record.userId,
    email: record.email,
    user_metadata: { offline: true },
    app_metadata: {},
    aud: 'authenticated',
    created_at: record.createdAt,
  } as User;
  return {
    access_token: 'offline-session-' + record.userId,
    refresh_token: 'offline-refresh-' + record.userId,
    expires_in: Math.max(60, Math.round((record.expiresAt - Date.now()) / 1000)),
    expires_at: Math.floor(record.expiresAt / 1000),
    token_type: 'bearer',
    user: mockUser,
  } as Session;
};

export type UserRole = 'owner' | 'cashier' | 'kitchen_staff' | 'manager' | 'super_admin' | 'unknown';

interface AuthState {
  user: User | null;
  session: Session | null;
  isLoading: boolean;
  isSuperAdmin: boolean;
  role: UserRole;
  isPasswordRecovery: boolean;
}

export const useAuth = () => {
  // Offline logins have no Supabase session to boot from, so restore one
  // synchronously — otherwise a reload always starts at the login screen.
  const [authState, setAuthState] = useState<AuthState>(() => {
    const restored = readOfflineSessionRecord();
    if (restored) {
      const session = buildOfflineSession(restored);
      return {
        user: session.user,
        session,
        isLoading: false,
        isSuperAdmin: restored.role === 'super_admin',
        role: (restored.role as UserRole) || 'unknown',
        isPasswordRecovery: false,
      };
    }
    return {
      user: null,
      session: null,
      isLoading: true,
      isSuperAdmin: false,
      role: 'unknown',
      isPasswordRecovery: false,
    };
  });

  const initialCheckDone = useRef(false);
  const authEventHandled = useRef(false);
  const loadingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isRecoveringRef = useRef(false);
  const recoveryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const readCachedRole = useCallback((userId: string): UserRole | null => {
    try {
      const value = localStorage.getItem(`${ROLE_CACHE_PREFIX}${userId}`);
      return value && value !== 'unknown' ? (value as UserRole) : null;
    } catch {
      return null;
    }
  }, []);

  const resolveRole = useCallback(async (_userId: string) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const { data, error } = await supabase.rpc('get_my_role');
        if (!error) {
          const role = (data as UserRole) || 'unknown';
          try {
            localStorage.setItem(`${ROLE_CACHE_PREFIX}${_userId}`, role);
          } catch {
            // non-critical
          }
          return { role, isSuperAdmin: role === 'super_admin' };
        }
        const msg = String(error?.message || '');
        if (!/fetch|network|timeout/i.test(msg)) {
          console.warn('get_my_role failed:', error);
          return { role: 'unknown' as UserRole, isSuperAdmin: false };
        }
      } catch (e) {
        if (attempt === 2) console.warn('resolveRole error:', e);
      }
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
    // Offline fallback: keep the last-known role for this user so a dead or
    // flaky connection can't drop them into an eternal route-guard loader.
    // The real authorization is enforced server-side (RLS); this is UX only.
    const cached = readCachedRole(_userId);
    if (cached) return { role: cached, isSuperAdmin: cached === 'super_admin' };
    return { role: 'unknown' as UserRole, isSuperAdmin: false };
  }, []);

  const applySession = useCallback((session: Session | null, isLoading = false) => {
    setAuthState(prev => ({
      ...prev,
      session,
      user: session?.user ?? null,
      isLoading,
      isSuperAdmin: session?.user ? prev.isSuperAdmin : false,
      role: session?.user ? prev.role : 'unknown',
    }));
  }, []);

  const clearRecoveryTimer = useCallback(() => {
    if (recoveryTimerRef.current) {
      clearTimeout(recoveryTimerRef.current);
      recoveryTimerRef.current = null;
    }
  }, []);

  /** Installs a persisted offline login as the active session. */
  const applyOfflineSession = useCallback((record: OfflineSessionRecord) => {
    clearRecoveryTimer();
    isRecoveringRef.current = false;
    const session = buildOfflineSession(record);
    setAuthState({
      user: session.user,
      session,
      isLoading: false,
      isSuperAdmin: record.role === 'super_admin',
      role: (record.role as UserRole) || 'unknown',
      isPasswordRecovery: false,
    });
  }, [clearRecoveryTimer]);

  useEffect(() => {
    loadingTimerRef.current = setTimeout(() => {
      if (authState.isLoading) {
        console.warn('[useAuth] Auth loading timed out — forcing ready state');
        setAuthState(prev => ({ ...prev, isLoading: false }));
      }
      loadingTimerRef.current = null;
    }, LOADING_TIMEOUT_MS);

    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (event, session) => {
        if (!initialCheckDone.current && event === 'INITIAL_SESSION') return;

        authEventHandled.current = true;
        clearTimeout(loadingTimerRef.current!);
        loadingTimerRef.current = null;

        console.log('[useAuth]', event, session ? 'session-ok' : 'session-null');

        if (session?.user) {
          // Session recovered or fresh login — cancel any pending recovery
          clearRecoveryTimer();
          isRecoveringRef.current = false;
          // If this is a PASSWORD_RECOVERY event, flag it so Auth page can show the reset form
          if (event === 'PASSWORD_RECOVERY') {
            setAuthState(prev => ({ ...prev, session, user: session.user, isLoading: false, isPasswordRecovery: true }));
            return;
          }
          // A real session supersedes any persisted offline login.
          clearOfflineSession();
          applySession(session);
          setTimeout(async () => {
            const { role, isSuperAdmin } = await resolveRole(session.user.id);
            setAuthState(prev => ({ ...prev, role, isSuperAdmin }));
          }, 0);
          return;
        }

        // ---- session is null ----
        // An explicit SIGNED_OUT must never resurrect a persisted offline
        // login (sign-out clears it first; this is defence in depth against
        // event-ordering races on flaky networks).
        if (event === 'SIGNED_OUT') {
          return;
        }
        // Offline logins never create a Supabase session, so there is nothing
        // for refreshSession() to recover — restore the persisted record
        // instead of dumping the user back on the login screen.
        const offlineRecord = readOfflineSessionRecord();
        if (offlineRecord) {
          applyOfflineSession(offlineRecord);
          return;
        }
        if (isRecoveringRef.current) return;
        isRecoveringRef.current = true;

        // Safety net: if recovery takes longer than RECOVERY_TIMEOUT_MS,
        // force-clear the session so the user sees the login page instead
        // of being stuck forever.
        recoveryTimerRef.current = setTimeout(() => {
          if (!isRecoveringRef.current) return;
          console.warn('[useAuth] Recovery timed out — clearing session');
          isRecoveringRef.current = false;
          applySession(null);
          setAuthState(prev => ({ ...prev, isSuperAdmin: false, role: 'unknown' }));
        }, RECOVERY_TIMEOUT_MS);

        // Step 1: try getSession (false alarm / transient storage glitch)
        supabase.auth.getSession()
          .then(({ data: { session: fresh } }) => {
            if (fresh?.user) {
              clearRecoveryTimer();
              isRecoveringRef.current = false;
              applySession(fresh);
              setTimeout(async () => {
                const { role, isSuperAdmin } = await resolveRole(fresh.user.id);
                setAuthState(prev => ({ ...prev, role, isSuperAdmin }));
              }, 0);
              return;
            }

            // Step 2: try refreshSession (access token expired but refresh token may work)
            console.warn('[useAuth] Session lost, trying refreshSession...');
            return supabase.auth.refreshSession();
          })
          .then((result) => {
            if (!result) return; // getSession already handled
            const { data: { session: refreshed }, error } = result;
            clearRecoveryTimer();
            isRecoveringRef.current = false;

            if (refreshed?.user) {
              console.log('[useAuth] refreshSession succeeded');
              applySession(refreshed);
              setTimeout(async () => {
                const { role, isSuperAdmin } = await resolveRole(refreshed.user.id);
                setAuthState(prev => ({ ...prev, role, isSuperAdmin }));
              }, 0);
            } else {
              console.warn('[useAuth] All recovery failed:', error?.message || 'no session');
              applySession(null);
              setAuthState(prev => ({ ...prev, isSuperAdmin: false, role: 'unknown' }));
            }
          })
          .catch((err) => {
            console.warn('[useAuth] Recovery error:', err);
            clearRecoveryTimer();
            isRecoveringRef.current = false;
            applySession(null);
            setAuthState(prev => ({ ...prev, isSuperAdmin: false, role: 'unknown' }));
          });
      }
    );

    supabase.auth.getSession()
      .then(async ({ data: { session }, error }) => {
        initialCheckDone.current = true;
        clearTimeout(loadingTimerRef.current!);
        loadingTimerRef.current = null;
        if (authEventHandled.current) return;
        if (error) console.warn('getSession returned an error:', error);

        if (!session?.user) {
          const offlineRecord = readOfflineSessionRecord();
          if (offlineRecord) {
            applyOfflineSession(offlineRecord);
            return;
          }
        }

        applySession(session);

        if (session?.user) {
          try {
            const { role, isSuperAdmin } = await resolveRole(session.user.id);
            setAuthState(prev => ({ ...prev, role, isSuperAdmin }));
          } catch (e) {
            console.warn('Role check failed (likely offline):', e);
          }
        }
      })
      .catch((err: unknown) => {
        console.warn('getSession failed, keeping existing state:', err);
        initialCheckDone.current = true;
        clearTimeout(loadingTimerRef.current!);
        loadingTimerRef.current = null;
        setAuthState(prev => ({ ...prev, isLoading: false }));
      });

    return () => {
      if (loadingTimerRef.current) clearTimeout(loadingTimerRef.current);
      loadingTimerRef.current = null;
      clearRecoveryTimer();
      subscription.unsubscribe();
    };
  }, [applySession, resolveRole, clearRecoveryTimer, applyOfflineSession]);

  const signUp = async (email: string, password: string, fullName: string, businessName: string, phone?: string, address?: string, affiliateCode?: string, businessType?: string) => {
    const { getAppUrl } = await import('@/lib/appUrl');
    const redirectUrl = `${getAppUrl()}/`;
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: redirectUrl,
        data: {
          full_name: fullName,
          business_name: businessName,
          phone: phone || null,
          address: address || null,
          affiliate_code: affiliateCode || null,
          business_type: businessType || 'retail',
        },
      },
    });
    return { data, error };
  };

  const signIn = async (email: string, password: string) => {
    try {
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (!error) {
        clearOfflineSession();
        applySession(data.session);
        if (data.session?.user) {
          setTimeout(async () => {
            const { role, isSuperAdmin } = await resolveRole(data.session.user.id);
            setAuthState(prev => ({ ...prev, role, isSuperAdmin }));
            try {
              const { cacheOfflineCredentials, hashPassword } = await import('@/lib/offlineStorage');
              const passwordHash = await hashPassword(password);
              await cacheOfflineCredentials({
                email,
                passwordHash,
                userId: data.session.user.id,
                role,
                lastOnlineLogin: new Date().toISOString(),
              });
            } catch (e) {
              console.warn('Failed to cache credentials for offline use:', e);
            }
            if (role !== 'super_admin') {
              try {
                const { cacheBusiness } = await import('@/lib/offlineStorage');
                const { data: groupData } = await supabase.rpc('get_my_business_group');
                const group = (groupData as Array<Record<string, unknown>>) ?? [];
                const root = group.find((g) => g.branch_kind === 'root') ?? group[0];
                const rootId = root?.id as string | undefined;
                if (rootId) {
                  const { data: row } = await supabase
                    .from('businesses')
                    .select('*')
                    .eq('id', rootId)
                    .maybeSingle();
                  if (row) {
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
                      taxMode: (row.tax_mode ?? 'none') as 'none' | 'vat' | 'custom',
                      vatRate: Number(row.vat_rate ?? 16),
                      customTaxName: row.custom_tax_name,
                      customTaxRate: row.custom_tax_rate != null ? Number(row.custom_tax_rate) : null,
                      tpin: row.tpin,
                      logoUrl: row.logo_url,
                      vatNumber: row.vat_number,
                      businessType: row.business_type ?? null,
                    }, data.session.user.id);
                  }
                }
              } catch (e) {
                console.warn('Failed to cache business for offline use:', e);
              }
            }
          }, 0);
        }
      }
      return { error };
    } catch (e) {
      console.warn('[useAuth] signIn threw:', e);
      return { error: e instanceof Error ? e : new Error('Sign in failed') };
    }
  };

  const signInOffline = async (email: string, password: string): Promise<{ error: Error | null }> => {
    try {
      const { verifyOfflineCredentials } = await import('@/lib/offlineStorage');
      const cached = await verifyOfflineCredentials(email, password);
      if (!cached) {
        return { error: new Error('Invalid email or password') };
      }
      const mockUser = {
        id: cached.userId,
        email: cached.email,
        user_metadata: {},
        app_metadata: {},
        aud: 'authenticated',
        created_at: cached.lastOnlineLogin,
      } as User;
      const mockSession = {
        access_token: 'offline-session-' + cached.userId,
        refresh_token: 'offline-refresh-' + cached.userId,
        expires_in: 86400,
        expires_at: Math.floor(Date.now() / 1000) + 86400,
        token_type: 'bearer',
        user: mockUser,
      } as Session;
      applySession(mockSession);
      persistOfflineSession({
        userId: cached.userId,
        email: cached.email,
        role: cached.role,
        createdAt: cached.lastOnlineLogin,
      });
      setAuthState(prev => ({
        ...prev,
        isSuperAdmin: cached.role === 'super_admin',
        role: cached.role as UserRole,
      }));
      return { error: null };
    } catch (e) {
      return { error: new Error('Offline login failed') };
    }
  };

  const signInOfflineCashier = async (businessCode: string, username: string, pin: string): Promise<{ error: Error | null }> => {
    try {
      const { getCashierLookup, verifyOfflineCredentials, cashierPinPassword } = await import('@/lib/offlineStorage');
      const lookupKey = `${businessCode.trim().toUpperCase()}:${username.trim().toLowerCase()}`;
      const lookup = await getCashierLookup(lookupKey);
      if (!lookup) {
        return { error: new Error('No cached cashier credentials for this device. Login once while online first.') };
      }
      const cached = await verifyOfflineCredentials(lookup.email, cashierPinPassword(pin));
      if (!cached) {
        return { error: new Error('Invalid business code, username or PIN') };
      }
      const mockUser = {
        id: cached.userId,
        email: cached.email,
        user_metadata: { cashier: true },
        app_metadata: {},
        aud: 'authenticated',
        created_at: cached.lastOnlineLogin,
      } as User;
      const mockSession = {
        access_token: 'offline-session-' + cached.userId,
        refresh_token: 'offline-refresh-' + cached.userId,
        expires_in: 86400,
        expires_at: Math.floor(Date.now() / 1000) + 86400,
        token_type: 'bearer',
        user: mockUser,
      } as Session;
      applySession(mockSession);
      persistOfflineSession({
        userId: cached.userId,
        email: cached.email,
        role: 'cashier',
        createdAt: cached.lastOnlineLogin,
      });
      setAuthState(prev => ({
        ...prev,
        isSuperAdmin: false,
        role: 'cashier',
      }));
      return { error: null };
    } catch (e) {
      return { error: new Error('Offline login failed') };
    }
  };

  /** Safe signOut — never throws, so callers can always navigate after. */
  const signOut = async () => {
    try {
      // Clear first: the SIGNED_OUT event below must not resurrect the
      // persisted offline login for this device.
      clearOfflineSession();
      // Clear in-memory state immediately. If the network is down,
      // supabase.auth.signOut() can fail or never emit SIGNED_OUT, and the
      // previous user would otherwise stay logged in.
      applySession(null);
      setAuthState(prev => ({ ...prev, isSuperAdmin: false, role: 'unknown', isPasswordRecovery: false }));
      const { error } = await supabase.auth.signOut();
      return { error };
    } catch (e) {
      console.warn('[useAuth] signOut threw:', e);
      return { error: e instanceof Error ? e : new Error('Sign out failed') };
    }
  };

  return {
    ...authState,
    signUp,
    signIn,
    signInOffline,
    signInOfflineCashier,
    signOut,
  };
};
