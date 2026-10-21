import { ReactNode, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthContext } from '@/contexts/AuthContext';
import { useBusiness } from '@/hooks/useBusiness';
import { useBusinessType } from '@/hooks/useBusinessType';

interface Props {
  children: ReactNode;
}

/**
 * Guards the production / manufacturing screens. Owners, managers and cashiers
 * pass through (cashiers get a read-only view); unknown/unauthenticated users
 * are sent to auth. Non-producer businesses are redirected to the dashboard
 * (production is producer-only).
 */
const RequireManufacturer = ({ children }: Props) => {
  const { isLoading, user } = useAuthContext();
  const { business, isLoading: bizLoading } = useBusiness(user?.id);
  const { isProducer } = useBusinessType(business?.id, business?.businessType);
  const navigate = useNavigate();

  const notProducer = !!business && !isProducer;

  useEffect(() => {
    if (isLoading || bizLoading) return;
    if (!user) {
      navigate('/auth', { replace: true });
      return;
    }
    if (notProducer) {
      navigate('/dashboard', { replace: true });
      return;
    }
  }, [isLoading, bizLoading, user, notProducer, navigate]);

  if (isLoading || bizLoading || !user || notProducer) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <p className="text-muted-foreground">Loading…</p>
      </div>
    );
  }

  return <>{children}</>;
};

export default RequireManufacturer;
