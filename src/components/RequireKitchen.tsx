import { ReactNode, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthContext } from '@/contexts/AuthContext';
import { useBusiness } from '@/hooks/useBusiness';
import { useBusinessType } from '@/hooks/useBusinessType';

interface Props {
  children: ReactNode;
}

/**
 * Guards the kitchen display screen. Kitchen staff and managers (plus owners
 * and super admins) pass through; plain cashiers are sent to the POS and
 * unknown/unauthenticated users to the auth page. Non-restaurant businesses
 * are redirected to the dashboard (the kitchen is restaurant-only).
 */
const RequireKitchen = ({ children }: Props) => {
  const { isLoading, user, role } = useAuthContext();
  const { business, isLoading: bizLoading } = useBusiness(user?.id);
  const { isRestaurant } = useBusinessType(business?.id, business?.businessType);
  const navigate = useNavigate();

  const notRestaurant = !!business && !isRestaurant;

  useEffect(() => {
    if (isLoading || bizLoading) return;
    if (!user) {
      navigate('/auth', { replace: true });
      return;
    }
    if (notRestaurant) {
      navigate('/dashboard', { replace: true });
      return;
    }
    if (role === 'cashier') {
      navigate('/pos', { replace: true });
      return;
    }
  }, [isLoading, bizLoading, user, role, notRestaurant, navigate]);

  if (isLoading || bizLoading || !user || notRestaurant) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <p className="text-muted-foreground">Loading…</p>
      </div>
    );
  }

  return <>{children}</>;
};

export default RequireKitchen;
