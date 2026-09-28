import { useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useToast } from "@/hooks/use-toast";

/**
 * GoTrue reports auth-link failures as a URL fragment:
 *   #error=access_denied&error_code=otp_expired&error_description=...
 *
 * supabase-js only reads access_token/refresh_token from that fragment, so
 * without this handler the user lands on the page with no feedback at all and
 * the verification "does nothing". This surfaces the reason and routes them to
 * /auth so they can request a fresh link.
 */
const MESSAGES: Record<string, { title: string; description: string }> = {
  otp_expired: {
    title: "Verification link expired",
    description: "That link is expired or was already used. Sign in and we'll send you a new one.",
  },
  access_denied: {
    title: "Verification failed",
    description: "We couldn't verify that link. Sign in and we'll send you a new one.",
  },
  validation_failed: {
    title: "Invalid verification link",
    description: "That link isn't valid. Sign in and we'll send you a new one.",
  },
  bad_code: {
    title: "Invalid code",
    description: "That code isn't valid. Sign in and we'll send you a new one.",
  },
  email_not_confirmed: {
    title: "Email not verified",
    description: "Check your inbox for the verification email, then click the link inside.",
  },
  over_email_send_rate_limit: {
    title: "Too many emails sent",
    description: "Too many verification emails in a short time. Wait a minute and try again.",
  },
};

export function AuthLinkHandler() {
  const { toast } = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const handled = useRef(false);

  useEffect(() => {
    if (handled.current) return;

    const hash = window.location.hash;
    if (!hash || !hash.includes("error")) return;
    handled.current = true;

    const params = new URLSearchParams(hash.slice(1));
    const code = params.get("error_code") || params.get("error") || "";
    const description = params.get("error_description") || "";
    const known = MESSAGES[code];

    toast({
      variant: "destructive",
      title: known?.title ?? "Verification failed",
      description:
        known?.description ??
        (description ? description.replace(/\+/g, " ") : "We couldn't verify that link. Please try again."),
    });

    // Strip the error fragment so a refresh doesn't re-show it.
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    navigate("/auth", { replace: true });
  }, [location, toast, navigate]);

  return null;
}

export default AuthLinkHandler;
