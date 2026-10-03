import { ReactNode, useEffect } from 'react';
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

/**
 * Wraps owner-only pages. Staff (cashiers, kitchen staff) are redirected to
 * their own screens. Owners, managers and super admins pass through.
 *
 * Fail-closed: an unresolved ("unknown") role is treated as NOT owner-class
 * and redirected to the staff screen. Real authorization is still enforced
 * server-side via RLS; this gate exists to avoid rendering owner UI to staff.
 */
const RequireOwner = ({ children, staffRedirect }: Props) => {
  const { isLoading, user, role } = useAuthContext();
  const navigate = useNavigate();
  const allowed = !!user && OWNER_CLASS_ROLES.has(role);

  useEffect(() => {
    if (isLoading) return;
    if (!user) {
      navigate('/auth', { replace: true });
      return;
    }
    if (!OWNER_CLASS_ROLES.has(role)) {
      const dest = role === 'kitchen_staff' ? '/kitchen' : (staffRedirect ?? '/pos');
      navigate(dest, { replace: true });
    }
  }, [isLoading, user, role, navigate, staffRedirect]);

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
