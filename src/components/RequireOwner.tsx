import { ReactNode, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthContext } from '@/contexts/AuthContext';

interface Props {
  children: ReactNode;
  /** Where to send staff roles when they hit an owner-only page. Default: /pos */
  staffRedirect?: string;
}

/**
 * Owner-class roles allowed through this guard. Managers are intentionally
 * included (they run the shop); cashiers and kitchen staff are not.
 */
const OWNER_CLASS_ROLES = new Set(['owner', 'manager', 'super_admin']);

/** Grace period before we act on a role that never resolved (RPC failure). */
const ROLE_RESOLVE_TIMEOUT_MS = 8000;

/**
 * Wraps owner-only pages. Staff (cashiers, kitchen staff) are redirected to
 * their own screens. Owners, managers and super admins pass through.
 *
 * An unresolved ("unknown") role shows Loading instead of navigating — on
 * refresh, `isLoading` flips false before the role RPC returns, and racing it
 * used to bounce owners to /pos. Fail-closed rendering (this guard only ever
 * shows owner UI to owner-class roles) is unchanged; real authorization is
 * still enforced server-side via RLS. If the role never resolves at all we
 * fall back to the staff redirect after a grace period so nobody hangs forever.
 */
const RequireOwner = ({ children, staffRedirect }: Props) => {
  const { isLoading, user, role } = useAuthContext();
  const navigate = useNavigate();
  const allowed = !!user && OWNER_CLASS_ROLES.has(role);
  const [roleTimedOut, setRoleTimedOut] = useState(false);

  useEffect(() => {
    if (role !== 'unknown') {
      setRoleTimedOut(false);
      return;
    }
    const t = setTimeout(() => setRoleTimedOut(true), ROLE_RESOLVE_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [role]);

  useEffect(() => {
    if (isLoading) return;
    if (!user) {
      navigate('/auth', { replace: true });
      return;
    }
    if (role === 'unknown') {
      if (roleTimedOut) navigate(staffRedirect ?? '/pos', { replace: true });
      return;
    }
    if (!OWNER_CLASS_ROLES.has(role)) {
      const dest = role === 'kitchen_staff' ? '/kitchen' : (staffRedirect ?? '/pos');
      navigate(dest, { replace: true });
    }
  }, [isLoading, user, role, roleTimedOut, navigate, staffRedirect]);

  if (isLoading || !allowed) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <p className="text-muted-foreground">Loading…</p>
      </div>
    );
  }

  return <>{children}</>;
};

export default RequireOwner;
