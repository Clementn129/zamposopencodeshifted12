import { useEffect, useState } from 'react';
import { AlertTriangle, ClipboardList, Bell, X } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { supabase } from '@/integrations/supabase/client';
import { todayLocal, localDayBounds } from '@/lib/dates';
import { Link } from 'react-router-dom';

type Notification = {
  id: string;
  type: 'stock_reminder' | 'subscription_expiry';
  title: string;
  message: string;
  icon: 'stock' | 'subscription';
  dismissed: boolean;
};

type DashboardNotificationsProps = {
  businessId: string;
  daysRemaining: number;
  subscriptionStatus: string;
  isService?: boolean;
};

const DISMISSED_KEY = 'zampos_dismissed_notifications';

const getDismissedToday = (): string[] => {
  try {
    const stored = localStorage.getItem(DISMISSED_KEY);
    if (!stored) return [];
    const { date, ids } = JSON.parse(stored);
    if (date !== todayLocal()) return [];
    return ids || [];
  } catch {
    return [];
  }
};

const dismissNotification = (id: string) => {
  const today = todayLocal();
  const current = getDismissedToday();
  localStorage.setItem(DISMISSED_KEY, JSON.stringify({ date: today, ids: [...current, id] }));
};

const DashboardNotifications = ({ businessId, daysRemaining, subscriptionStatus, isService }: DashboardNotificationsProps) => {
  const [notifications, setNotifications] = useState<Notification[]>([]);

  useEffect(() => {
    const buildNotifications = async () => {
      const dismissed = getDismissedToday();
      const notifs: Notification[] = [];

      // 1. Subscription expiry warning (3 days or less)
      if (
        (subscriptionStatus === 'trial' || subscriptionStatus === 'active') &&
        daysRemaining <= 3 &&
        daysRemaining > 0 &&
        !dismissed.includes('subscription_expiry')
      ) {
        notifs.push({
          id: 'subscription_expiry',
          type: 'subscription_expiry',
          title: 'Subscription Expiring Soon',
          message: `Your ${subscriptionStatus === 'trial' ? 'trial' : 'subscription'} expires in ${daysRemaining} day${daysRemaining !== 1 ? 's' : ''}. Renew now to avoid losing access.`,
          icon: 'subscription',
          dismissed: false,
        });
      }

      // 2. Daily stock recording reminder (only for retail businesses)
      if (!isService && !dismissed.includes('stock_reminder')) {
        const { from: todayStartIso, to: todayEndIso } = localDayBounds();
        const { count } = await supabase
          .from('sales')
          .select('id', { count: 'exact', head: true })
          .eq('business_id', businessId)
          .gte('created_at', todayStartIso)
          .lte('created_at', todayEndIso);

        if (count === 0) {
          notifs.push({
            id: 'stock_reminder',
            type: 'stock_reminder',
            title: 'Daily Stock Reminder',
            message: "No sales recorded today. Don't forget to log your stock movements and sales for accurate tracking.",
            icon: 'stock',
            dismissed: false,
          });
        }
      }

      setNotifications(notifs);
    };

    if (businessId) {
      buildNotifications();
    }
  }, [businessId, daysRemaining, subscriptionStatus, isService]);

  const handleDismiss = (id: string) => {
    dismissNotification(id);
    setNotifications(prev => prev.filter(n => n.id !== id));
  };

  if (notifications.length === 0) return null;

  return (
    <div className="space-y-2">
      {notifications.map((notif) => (
        <Card
          key={notif.id}
          className={
            notif.type === 'subscription_expiry'
              ? 'border-destructive/50 bg-destructive/5'
              : 'border-primary/50 bg-primary/5'
          }
        >
          <CardContent className="p-3">
            <div className="flex items-start gap-3">
              <div className={`mt-0.5 rounded-lg p-1.5 ${
                notif.type === 'subscription_expiry'
                  ? 'bg-destructive/10 text-destructive'
                  : 'bg-primary/10 text-primary'
              }`}>
                {notif.type === 'subscription_expiry' ? (
                  <AlertTriangle className="h-4 w-4" />
                ) : (
                  <ClipboardList className="h-4 w-4" />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <h4 className="text-sm font-semibold">{notif.title}</h4>
                  <button
                    onClick={() => handleDismiss(notif.id)}
                    className="text-muted-foreground hover:text-foreground shrink-0"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">{notif.message}</p>
                {notif.type === 'subscription_expiry' && (
                  <Link to="/subscription">
                    <Button size="sm" variant="destructive" className="mt-2 h-7 text-xs">
                      Renew Now
                    </Button>
                  </Link>
                )}
                {notif.type === 'stock_reminder' && (
                  <Link to="/pos">
                    <Button size="sm" variant="default" className="mt-2 h-7 text-xs">
                      Record Sales
                    </Button>
                  </Link>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
};

export default DashboardNotifications;
