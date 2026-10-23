import { useLocation, useNavigate } from "react-router-dom";
import { WifiOff } from "lucide-react";
import { useAuthContext } from "@/contexts/AuthContext";
import { useOnlineStatus } from "@/hooks/useOnlineStatus";

const AUTH_PATHS = ["/auth", "/admin/login", "/admin-login"];

/**
 * An offline login cannot authenticate Supabase requests, so once the network
 * is back the app must guide the user to sign in again — otherwise every sync
 * silently fails with "permission denied" and pending sales never leave the
 * device. Unsigned data is preserved: exiting the offline session deliberately
 * does not clear caches or the pending-op queue.
 */
const OfflineSessionNotice = () => {
  const { isOfflineSession, exitOfflineSession } = useAuthContext();
  const { isOnline } = useOnlineStatus();
  const location = useLocation();
  const navigate = useNavigate();

  if (!isOfflineSession || !isOnline || AUTH_PATHS.includes(location.pathname)) {
    return null;
  }

  return (
    <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 bg-yellow-500 px-4 py-2 text-sm font-medium text-yellow-950">
      <WifiOff className="h-4 w-4 shrink-0" />
      <span>Signed in offline. Sign in again to load your data and sync pending sales.</span>
      <button
        type="button"
        className="rounded bg-yellow-950 px-2 py-1 text-xs font-semibold text-yellow-50 hover:bg-yellow-900"
        onClick={() => {
          exitOfflineSession();
          navigate("/auth");
        }}
      >
        Sign in
      </button>
    </div>
  );
};

export default OfflineSessionNotice;
