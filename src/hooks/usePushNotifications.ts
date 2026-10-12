import { useEffect, useCallback } from 'react';
import { todayLocal } from '@/lib/dates';

const LAST_PUSH_KEY = 'zampos_last_push_check';

const isInIframe = (() => {
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
})();

const isPreviewHost =
  typeof window !== 'undefined' &&
  (window.location.hostname.includes('id-preview--') ||
   window.location.hostname.includes('lovableproject.com'));

export const usePushNotifications = (
  daysRemaining: number,
  subscriptionStatus: string,
  hasSalesToday: boolean,
  isService: boolean,
) => {
  const requestPermission = useCallback(async () => {
    if (isInIframe || isPreviewHost) return false;
    if (!('Notification' in window)) return false;
    if (Notification.permission === 'granted') return true;
    if (Notification.permission === 'denied') return false;
    const result = await Notification.requestPermission();
    return result === 'granted';
  }, []);

  const sendNotification = useCallback((title: string, body: string, tag: string) => {
    if (isInIframe || isPreviewHost) return;
    if (!('Notification' in window) || Notification.permission !== 'granted') return;

    try {
      new Notification(title, {
        body,
        icon: '/icon-192.png',
        tag,
      });
    } catch (e) {
      // fallback not needed
    }
  }, []);

  const checkAndNotify = useCallback(async () => {
    if (isInIframe || isPreviewHost) return;

    const today = todayLocal();
    const lastCheck = localStorage.getItem(LAST_PUSH_KEY);
    if (lastCheck === today) return;

    const hasPermission = await requestPermission();
    if (!hasPermission) return;

    localStorage.setItem(LAST_PUSH_KEY, today);

    // Subscription expiry warning
    if (
      (subscriptionStatus === 'trial' || subscriptionStatus === 'active') &&
      daysRemaining <= 3 &&
      daysRemaining > 0
    ) {
      sendNotification(
        '⚠️ Subscription Expiring',
        `Your ${subscriptionStatus} expires in ${daysRemaining} day${daysRemaining !== 1 ? 's' : ''}. Renew to keep access.`,
        'subscription-expiry',
      );
    }

    // Stock reminder (only for retail)
    if (!isService && !hasSalesToday) {
      setTimeout(() => {
        sendNotification(
          '📋 Daily Stock Reminder',
          "Don't forget to record today's sales and stock movements.",
          'stock-reminder',
        );
      }, 2000);
    }
  }, [daysRemaining, subscriptionStatus, hasSalesToday, isService, requestPermission, sendNotification]);

  useEffect(() => {
    // Slight delay to not block initial render
    const timer = setTimeout(checkAndNotify, 3000);
    return () => clearTimeout(timer);
  }, [checkAndNotify]);

  return { requestPermission };
};
