import { ReactNode, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthContext } from '@/contexts/AuthContext';
import { useBusiness } from '@/hooks/useBusiness';
import { useBusinessType } from '@/hooks/useBusinessType';

interface Props {
  children: ReactNode;
  restaurantOnly?: boolean;
}

/**
 * Guards member-only pages (floor plan, etc.). Any authenticated member of a
 * business passes through: owners, managers, cashiers and kitchen staff.
 * Unauthenticated users are sent to the auth page. When `restaurantOnly` is
 * set, non-restaurant businesses are redirected to the dashboard.
 */
const RequireMember = ({ children, restaurantOnly = false }: Props) => {
  const { isLoading, user } = useAuthContext();
  const { business, isLoading: bizLoading } = useBusiness(user?.id);
  const { isRestaurant } = useBusinessType(business?.id, business?.businessType);
  const navigate = useNavigate();

  const notRestaurant = restaurantOnly && !!business && !isRestaurant;

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
  }, [isLoading, bizLoading, user, notRestaurant, navigate]);

  if (isLoading || bizLoading || !user || notRestaurant) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <p className="text-muted-foreground">Loading…</p>
      </div>
    );
  }

  return <>{children}</>;
};

export default RequireMember;