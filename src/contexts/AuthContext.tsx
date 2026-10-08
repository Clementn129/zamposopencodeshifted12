import React, { createContext, useContext, ReactNode } from 'react';
import { User, Session } from '@supabase/supabase-js';
import { useAuth, UserRole } from '@/hooks/useAuth';

interface AuthContextType {
  user: User | null;
  session: Session | null;
  isLoading: boolean;
  isSuperAdmin: boolean;
  isPasswordRecovery: boolean;
  role: UserRole;
  signUp: (email: string, password: string, fullName: string, businessName: string, phone?: string, address?: string, affiliateCode?: string) => Promise<{ data: any; error: Error | null }>;
  signIn: (email: string, password: string) => Promise<{ error: Error | null }>;
  signInOffline: (email: string, password: string) => Promise<{ error: Error | null }>;
  signInOfflineCashier: (businessCode: string, username: string, pin: string) => Promise<{ error: Error | null }>;
  signOut: () => Promise<{ error: Error | null }>;
  clearPasswordRecovery: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const { signInOffline, signInOfflineCashier, ...auth } = useAuth();
  return <AuthContext.Provider value={{ ...auth, signInOffline, signInOfflineCashier }}>{children}</AuthContext.Provider>;
};

export const useAuthContext = () => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuthContext must be used within an AuthProvider');
  }
  return context;
};
