import { useEffect, useRef } from "react";
import { useAuthContext } from "@/contexts/AuthContext";
import { useOnlineStatus } from "@/hooks/useOnlineStatus";
import { clearActivationSecret, getActivationSecret } from "@/lib/electron";

/**
 * After a zero-network activation, the sync password is kept in the OS vault.
 * Once the PC reaches the internet, use it once to create a real Supabase
 * session, then delete it. If the owner signs in manually first, the stale
 * secret is also dropped.
 */
export const ActivationFirstSync = () => {
  const { user, isLoading, isOfflineSession, signIn } = useAuthContext();
  const online = useOnlineStatus();
  const attempted = useRef(false);

  useEffect(() => {
    if (user && !isOfflineSession) {
      void clearActivationSecret();
    }
  }, [user, isOfflineSession]);

  useEffect(() => {
    if (attempted.current || isLoading || !online || user) return;
    let cancelled = false;
    attempted.current = true;

    void (async () => {
      const secret = await getActivationSecret();
      if (!secret || cancelled) return;
      const { error } = await signIn(secret.email, secret.password);
      if (!error && !cancelled) {
        await clearActivationSecret();
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isLoading, online, user, signIn]);

  return null;
};

export default ActivationFirstSync;
