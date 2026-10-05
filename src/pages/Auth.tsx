import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { useAuthContext } from '@/contexts/AuthContext';
import { supabase } from '@/integrations/supabase/client';
import { getAppUrl } from '@/lib/appUrl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useToast } from '@/hooks/use-toast';
import { Store, Mail, Lock, User, Building2, Loader2, Phone, MapPin, ArrowLeft, Eye, EyeOff, Gift, Wallet, Briefcase } from 'lucide-react';
import { validateAffiliateCode } from '@/hooks/useAffiliate';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

// Supabase auth errors don't always carry a plain string on `.message` — the
// client can surface an object (or nothing at all) when the request fails below
// the auth layer, e.g. an SMTP send error. Rendering that directly gave users a
// bare "Registration failed {}". Dig out a usable sentence instead.
function describeAuthError(error: unknown, fallback: string): string {
  if (!error) return fallback;
  if (typeof error === 'string') return error.trim() || fallback;
  if (error instanceof Error && error.message) return error.message;

  if (typeof error === 'object') {
    const e = error as Record<string, unknown>;
    for (const key of ['message', 'msg', 'error_description', 'error']) {
      const v = e[key];
      if (typeof v === 'string' && v.trim()) return v.trim();
      // One level deeper: some clients nest the real reason under `error`.
      if (v && typeof v === 'object') {
        const nested = (v as Record<string, unknown>).message;
        if (typeof nested === 'string' && nested.trim()) return nested.trim();
      }
    }
  }
  return fallback;
}

// Supabase reports email-throttling as a 429 / "rate limit" failure. Recognise it
// so the user gets a real instruction instead of a generic failure.
function isEmailRateLimit(error: unknown): boolean {
  const msg = describeAuthError(error, '').toLowerCase();
  return /rate limit|429|too many|security purposes|email address .* rate/.test(msg);
}

const Auth = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { signIn, signInOffline, signInOfflineCashier, signUp, user, role, isPasswordRecovery } = useAuthContext();
  const { toast } = useToast();
  const [isLoading, setIsLoading] = useState(false);
  const [showForgotPassword, setShowForgotPassword] = useState(false);

  // Cashier login
  const [cashierCode, setCashierCode] = useState('');
  const [cashierUsername, setCashierUsername] = useState('');
  const [cashierPin, setCashierPin] = useState('');
  const [resetEmail, setResetEmail] = useState('');
  
  // Password reset form
  const [newPassword, setNewPassword] = useState('');
  const [confirmNewPassword, setConfirmNewPassword] = useState('');
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [resetSuccess, setResetSuccess] = useState(false);
  
  // Login form
  const [loginEmail, setLoginEmail] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [unconfirmedEmail, setUnconfirmedEmail] = useState<string | null>(null);
  const [isResending, setIsResending] = useState(false);
  // Resend is rate-limited by Supabase (2 emails/hour by default), so the button
  // gets a cooldown and a rate-limit-specific message instead of failing with a
  // generic error the user can't act on.
  const [resendCooldown, setResendCooldown] = useState(0);
  const [resendRateLimited, setResendRateLimited] = useState(false);
  // Resend attempts are capped per email address per day. The email provider is on
  // a free tier with a small monthly quota, so this stops one person burning it by
  // hammering the button. Stored in localStorage so a refresh can't reset it.
  const [resendCount, setResendCount] = useState(0);
  const RESEND_DAILY_LIMIT = 3;
  
  // Register form
  const [registerEmail, setRegisterEmail] = useState('');
  const [registerPassword, setRegisterPassword] = useState('');
  const [registerFullName, setRegisterFullName] = useState('');
  const [registerBusinessName, setRegisterBusinessName] = useState('');
  const [registerPhone, setRegisterPhone] = useState('');
  const [registerAddress, setRegisterAddress] = useState('');
  const [registerBusinessType, setRegisterBusinessType] = useState('');
  const [affiliateCode, setAffiliateCode] = useState('');
  
  // Password visibility
  const [showLoginPassword, setShowLoginPassword] = useState(false);
  const [showRegisterPassword, setShowRegisterPassword] = useState(false);

  // Check for referral code in URL
  useEffect(() => {
    const refCode = searchParams.get('ref');
    if (refCode) {
      setAffiliateCode(refCode.toUpperCase());
    }
  }, [searchParams]);

  // Tick down the resend cooldown
  useEffect(() => {
    if (resendCooldown <= 0) return;
    const timer = window.setTimeout(() => setResendCooldown((s) => s - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [resendCooldown]);

  // Load today's resend count for the pending unconfirmed email
  useEffect(() => {
    if (!unconfirmedEmail) return;
    try {
      const raw = localStorage.getItem(`zampos_resend_${unconfirmedEmail.toLowerCase()}`);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (parsed.date === new Date().toDateString() && typeof parsed.count === 'number') {
        setResendCount(parsed.count);
      }
    } catch {
      // Ignore malformed storage — treat as no attempts today.
    }
  }, [unconfirmedEmail]);

  const dailyLimitReached = resendCount >= RESEND_DAILY_LIMIT;

  // Redirect if already logged in (but NOT during password recovery)
  useEffect(() => {
    if (!user || role === 'unknown' || isPasswordRecovery) return;
    if (role === 'cashier') navigate('/pos');
    else if (role === 'kitchen_staff' || role === 'manager') navigate('/kitchen');
    else navigate('/dashboard');
  }, [user, role, navigate, isPasswordRecovery]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);

    try {
      const { error } = await signIn(loginEmail, loginPassword);
      
      if (error) {
        const msg = String(error.message || '').toLowerCase();
        const isNetworkError = /fetch|network|timeout|offline|failed to connect/i.test(msg);
        
        if (isNetworkError) {
          const { error: offlineError } = await signInOffline(loginEmail, loginPassword);
          if (offlineError) {
            toast({
              variant: 'destructive',
              title: 'Offline Login Failed',
              description: 'No internet and no cached credentials available.',
            });
          } else {
            toast({
              title: 'Offline Mode',
              description: 'Signed in with cached credentials.',
            });
          }
        } else if (msg.includes('email not confirmed')) {
          setUnconfirmedEmail(loginEmail.trim());
          toast({
            variant: 'destructive',
            title: 'Email not verified',
            description: 'Check your inbox for the verification link, or resend it below.',
          });
        } else {
          toast({
            variant: 'destructive',
            title: 'Login Failed',
            description: error.message || 'Invalid email or password',
          });
        }
      } else {
        setUnconfirmedEmail(null);
        setResendRateLimited(false);
        setResendCooldown(0);
        toast({
          title: 'Welcome back!',
          description: 'You have successfully logged in.',
        });
      }
    } catch (err) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Something went wrong. Please try again.',
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleResendConfirmation = async () => {
    const email = (unconfirmedEmail || loginEmail).trim();
    if (!email || isResending || resendCooldown > 0 || dailyLimitReached) return;
    setIsResending(true);
    try {
      const { error } = await supabase.auth.resend({
        type: 'signup',
        email,
        options: { emailRedirectTo: `${getAppUrl()}/` },
      });
      if (error) throw new Error(describeAuthError(error, 'Email delivery failed.'));
      setUnconfirmedEmail(email);
      setResendRateLimited(false);
      setResendCooldown(60);
      // Only a send that actually succeeded consumes the daily allowance.
      setResendCount((c) => {
        const next = c + 1;
        try {
          localStorage.setItem(
            `zampos_resend_${email.toLowerCase()}`,
            JSON.stringify({ date: new Date().toDateString(), count: next })
          );
        } catch {
          // Storage full or blocked — the cap is a courtesy, not a security control.
        }
        return next;
      });
      toast({
        title: 'Verification email sent',
        description: `We sent a new link to ${email}. Check your inbox and spam folder.`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      // Supabase reports email throttling as a 429 / "rate limit" error. Tell the
      // user that plainly so they wait instead of hammering the button.
      const isRateLimit = /rate limit|429|too many|security purposes/i.test(msg);
      if (isRateLimit) setResendRateLimited(true);
      toast({
        variant: 'destructive',
        title: isRateLimit ? 'Too many attempts' : 'Could not resend email',
        description: isRateLimit
          ? `We've hit the email limit for now. Wait about an hour, then try again — or contact support with ${email}.`
          : (msg || 'Please try again in a few minutes.'),
      });
    } finally {
      setIsResending(false);
    }
  };

  const handleCashierLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!cashierCode.trim() || !cashierUsername.trim() || !cashierPin.trim()) {
      toast({ variant: 'destructive', title: 'Missing details', description: 'Enter business code, username and PIN.' });
      return;
    }
    if (!/^\d{4,6}$/.test(cashierPin)) {
      toast({ variant: 'destructive', title: 'Invalid PIN', description: 'PIN must be 4-6 digits.' });
      return;
    }
    setIsLoading(true);
    try {
      const { data, error: fnErr } = await supabase.functions.invoke('manage-cashier', {
        body: {
          action: 'cashier_login',
          code: cashierCode.trim().toUpperCase(),
          username: cashierUsername.trim().toLowerCase(),
          pin: cashierPin,
        },
      });
      if (fnErr) throw new Error(fnErr.message || 'Login failed');
      const { email, password } = (data ?? {}) as { email?: string; password?: string };
      if (!email || !password) throw new Error('Invalid response from server');

      const { error: signInErr } = await signIn(email, password);
      if (signInErr) throw signInErr;

      // Cache an offline lookup for this cashier (keyed by code+username) so
      // they can sign in with no internet next time. Best-effort only.
      try {
        const { cacheCashierLookup } = await import('@/lib/offlineStorage');
        await cacheCashierLookup({
          lookupKey: `${cashierCode.trim().toUpperCase()}:${cashierUsername.trim().toLowerCase()}`,
          email,
          username: cashierUsername.trim().toLowerCase(),
          businessCode: cashierCode.trim().toUpperCase(),
        });
      } catch {
        // non-fatal
      }

      toast({ title: 'Signed in', description: 'Welcome.' });
      navigate('/pos');
    } catch (err) {
      const msg = String(err instanceof Error ? err.message : '').toLowerCase();
      const isNetworkError = /fetch|network|timeout|offline|failed to connect|load failed|networkerror/i.test(msg);
      if (isNetworkError) {
        const { error: offlineError } = await signInOfflineCashier(cashierCode, cashierUsername, cashierPin);
        if (offlineError) {
          toast({
            variant: 'destructive',
            title: 'Offline login failed',
            description: offlineError.message,
          });
        } else {
          toast({ title: 'Offline Mode', description: 'Signed in as cashier with cached credentials.' });
          navigate('/pos');
        }
      } else {
        toast({
          variant: 'destructive',
          title: 'Cashier login failed',
          description: err instanceof Error ? err.message : 'Check your business code, username and PIN.',
        });
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleForgotPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);

    try {
      const { error } = await supabase.auth.resetPasswordForEmail(resetEmail, {
        redirectTo: `${getAppUrl()}/auth?reset=true`,
      });

      if (error) {
        toast({
          variant: 'destructive',
          title: 'Reset Failed',
          description: error.message,
        });
      } else {
        toast({
          title: 'Check your email',
          description: 'We sent you a password reset link. Please check your inbox.',
        });
        setShowForgotPassword(false);
        setResetEmail('');
      }
    } catch (err) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Something went wrong. Please try again.',
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleResetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);

    if (newPassword !== confirmNewPassword) {
      toast({
        variant: 'destructive',
        title: 'Passwords do not match',
        description: 'Please make sure both passwords are the same.',
      });
      setIsLoading(false);
      return;
    }

    if (newPassword.length < 6) {
      toast({
        variant: 'destructive',
        title: 'Password too short',
        description: 'Password must be at least 6 characters.',
      });
      setIsLoading(false);
      return;
    }

    try {
      const { error } = await supabase.auth.updateUser({ password: newPassword });

      if (error) {
        toast({
          variant: 'destructive',
          title: 'Reset Failed',
          description: error.message,
        });
      } else {
        setResetSuccess(true);
        toast({
          title: 'Password Updated',
          description: 'Your password has been changed successfully.',
        });
      }
    } catch (err) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Something went wrong. Please try again.',
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);

    if (!registerFullName.trim() || !registerBusinessName.trim()) {
      toast({
        variant: 'destructive',
        title: 'Missing Information',
        description: 'Please fill in all required fields.',
      });
      setIsLoading(false);
      return;
    }

    // Validate email contains @
    if (!registerEmail.includes('@')) {
      toast({ variant: 'destructive', title: 'Invalid Email', description: 'Please enter a valid email address.' });
      setIsLoading(false);
      return;
    }

    // Validate phone is numeric (if provided)
    if (registerPhone.trim() && !/^[\d\s+()-]+$/.test(registerPhone.trim())) {
      toast({ variant: 'destructive', title: 'Invalid Phone', description: 'Phone number must contain only digits.' });
      setIsLoading(false);
      return;
    }

    // Validate affiliate code if provided
    let validAffiliateId: string | null = null;
    if (affiliateCode.trim()) {
      validAffiliateId = await validateAffiliateCode(affiliateCode.trim());
      if (!validAffiliateId) {
        toast({
          variant: 'destructive',
          title: 'Invalid Affiliate Code',
          description: 'The affiliate code you entered is not valid or inactive.',
        });
        setIsLoading(false);
        return;
      }
    }

    try {
      const { data, error } = await signUp(
        registerEmail, 
        registerPassword, 
        registerFullName.trim(), 
        registerBusinessName.trim(),
        registerPhone.trim() || undefined,
        registerAddress.trim() || undefined,
        validAffiliateId ? affiliateCode.trim() : undefined,
        registerBusinessType || undefined
      );
      
      if (error) {
        let message = describeAuthError(
          error,
          'Something went wrong while creating your account. Please try again.'
        );
        if (/already registered|already exists/i.test(message)) {
          message = 'This email is already registered. Please login instead.';
        }
        // Signup can succeed but fail on the confirmation email. Say so plainly,
        // otherwise the user retries and ends up with a duplicate-looking error.
        if (/error sending confirmation email|unexpected_failure/i.test(message)) {
          message =
            'Your account was created, but the verification email could not be sent. Please contact support and we will activate it for you.';
        }
        toast({
          variant: 'destructive',
          title: 'Registration Failed',
          description: message,
        });
      } else if (!data?.session) {
        toast({
          title: 'Check your email',
          description: 'We sent you a confirmation link. Please check your inbox to activate your account.',
        });
        setLoginEmail(registerEmail);
        setLoginPassword(registerPassword);
        // Surfacing the email here makes the resend panel appear immediately after
        // signup. Without this a user whose confirmation mail never arrives has no
        // resend button until they attempt a login and hit "email not confirmed".
        setUnconfirmedEmail(registerEmail.trim());
      } else {
        toast({
          title: 'Welcome to Sale Point!',
          description: 'Your account and business have been created. You have a 3-day free trial.',
        });
      }
    } catch (err) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Something went wrong. Please try again.',
      });
    } finally {
      setIsLoading(false);
    }
  };

  // Password Recovery View — shown when user clicks the reset link in email
  if (isPasswordRecovery && searchParams.get('reset') === 'true') {
    if (resetSuccess) {
      return (
        <div className="min-h-screen bg-background flex items-center justify-center p-4">
          <div className="w-full max-w-md animate-fade-in">
            <div className="text-center mb-8">
              <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-primary mb-4">
                <Store className="w-8 h-8 text-primary-foreground" />
              </div>
              <h1 className="text-3xl font-display font-bold text-foreground">Sale Point</h1>
            </div>
            <Card className="border-border/50 shadow-lg">
              <CardContent className="pt-6 text-center space-y-4">
                <p className="text-foreground font-medium">Password updated successfully!</p>
                <Button variant="pos" className="w-full" onClick={async () => {
                  await signOut();
                  navigate('/auth');
                }}>
                  Sign In with New Password
                </Button>
              </CardContent>
            </Card>
          </div>
        </div>
      );
    }

    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <div className="w-full max-w-md animate-fade-in">
          <div className="text-center mb-8">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-primary mb-4">
              <Store className="w-8 h-8 text-primary-foreground" />
            </div>
            <h1 className="text-3xl font-display font-bold text-foreground">Sale Point</h1>
            <p className="text-muted-foreground mt-2">Set your new password</p>
          </div>

          <Card className="border-border/50 shadow-lg">
            <CardHeader>
              <CardTitle className="text-xl">New Password</CardTitle>
              <CardDescription>
                Enter your new password below.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleResetPassword} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="new-password">New Password</Label>
                  <div className="relative">
                    <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input
                      id="new-password"
                      type={showNewPassword ? "text" : "password"}
                      placeholder="••••••••"
                      className="pl-10 pr-10"
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      required
                      minLength={6}
                    />
                    <button
                      type="button"
                      onClick={() => setShowNewPassword(!showNewPassword)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    >
                      {showNewPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="confirm-new-password">Confirm Password</Label>
                  <div className="relative">
                    <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input
                      id="confirm-new-password"
                      type={showNewPassword ? "text" : "password"}
                      placeholder="••••••••"
                      className="pl-10"
                      value={confirmNewPassword}
                      onChange={(e) => setConfirmNewPassword(e.target.value)}
                      required
                      minLength={6}
                    />
                  </div>
                </div>

                <Button 
                  type="submit" 
                  variant="pos"
                  className="w-full"
                  disabled={isLoading}
                >
                  {isLoading ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Updating...
                    </>
                  ) : (
                    'Update Password'
                  )}
                </Button>
              </form>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  // Forgot Password View
  if (showForgotPassword) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <div className="w-full max-w-md animate-fade-in">
          {/* Logo */}
          <div className="text-center mb-8">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-primary mb-4">
              <Store className="w-8 h-8 text-primary-foreground" />
            </div>
            <h1 className="text-3xl font-display font-bold text-foreground">Sale Point</h1>
            <p className="text-muted-foreground mt-2">Reset your password</p>
          </div>

          <Card className="border-border/50 shadow-lg">
            <CardHeader>
              <Button 
                variant="ghost" 
                size="sm" 
                className="w-fit mb-2"
                onClick={() => setShowForgotPassword(false)}
              >
                <ArrowLeft className="w-4 h-4 mr-2" />
                Back to Login
              </Button>
              <CardTitle className="text-xl">Forgot Password</CardTitle>
              <CardDescription>
                Enter your email address and we'll send you a link to reset your password.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleForgotPassword} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="reset-email">Email Address</Label>
                  <div className="relative">
                    <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input
                      id="reset-email"
                      type="email"
                      placeholder="you@example.com"
                      className="pl-10"
                      value={resetEmail}
                      onChange={(e) => setResetEmail(e.target.value)}
                      required
                    />
                  </div>
                </div>
                
                <Button 
                  type="submit" 
                  variant="pos"
                  className="w-full"
                  disabled={isLoading}
                >
                  {isLoading ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Sending...
                    </>
                  ) : (
                    'Send Reset Link'
                  )}
                </Button>
              </form>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-md animate-fade-in">
        {/* Logo */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-primary mb-4">
            <Store className="w-8 h-8 text-primary-foreground" />
          </div>
          <h1 className="text-3xl font-display font-bold text-foreground">Sale Point</h1>
          <p className="text-muted-foreground mt-2">Point of Sale for Zambian Businesses</p>
        </div>

        <Card className="border-border/50 shadow-lg">
          <Tabs defaultValue={searchParams.get('tab') === 'register' ? 'register' : searchParams.get('tab') === 'cashier' ? 'cashier' : 'login'} className="w-full">
            <CardHeader className="pb-4">
              <TabsList className="grid w-full grid-cols-3">
                <TabsTrigger value="login">Owner</TabsTrigger>
                <TabsTrigger value="cashier">Cashier</TabsTrigger>
                <TabsTrigger value="register">Register</TabsTrigger>
              </TabsList>
            </CardHeader>
            
            <CardContent>
              <TabsContent value="login" className="mt-0">
                <CardTitle className="text-xl mb-1">Welcome Back</CardTitle>
                <CardDescription className="mb-6">
                  Sign in to access your business dashboard
                </CardDescription>

                {unconfirmedEmail && (
                  <div className="mb-4 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
                    <p className="font-medium text-amber-600 dark:text-amber-400">
                      {unconfirmedEmail} is not verified yet
                    </p>
                    <p className="mt-1 text-muted-foreground">
                      Open the verification email and click the link. Didn&apos;t get it? Check spam, or resend it.
                    </p>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="mt-2"
                      disabled={isResending || resendCooldown > 0 || dailyLimitReached}
                      onClick={handleResendConfirmation}
                    >
                      {dailyLimitReached
                        ? "Try again tomorrow"
                        : isResending
                          ? 'Sending…'
                          : resendCooldown > 0
                            ? `Resend again in ${resendCooldown}s`
                          : 'Resend verification email'}
                    </Button>
                    <p className="mt-2 text-xs text-muted-foreground">
                      {dailyLimitReached
                        ? `You've used all ${RESEND_DAILY_LIMIT} resend requests for today. Try again tomorrow, or contact support with this address and we'll activate your account for you.`
                        : `${RESEND_DAILY_LIMIT - resendCount} resend request${RESEND_DAILY_LIMIT - resendCount === 1 ? '' : 's'} left today.`}
                    </p>
                    {resendRateLimited && !dailyLimitReached && (
                      <p className="mt-2 text-xs text-muted-foreground">
                        Still nothing? Email delivery is rate-limited. Contact support with this
                        address and we&apos;ll activate your account for you.
                      </p>
                    )}
                  </div>
                )}
                
                <form onSubmit={handleLogin} className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="login-email">Email</Label>
                    <div className="relative">
                      <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                      <Input
                        id="login-email"
                        type="email"
                        placeholder="you@example.com"
                        className="pl-10"
                        value={loginEmail}
                        onChange={(e) => setLoginEmail(e.target.value)}
                        required
                      />
                    </div>
                  </div>
                  
                  <div className="space-y-2">
                    <Label htmlFor="login-password">Password</Label>
                    <div className="relative">
                      <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                      <Input
                        id="login-password"
                        type={showLoginPassword ? "text" : "password"}
                        placeholder="••••••••"
                        className="pl-10 pr-10"
                        value={loginPassword}
                        onChange={(e) => setLoginPassword(e.target.value)}
                        required
                        minLength={6}
                      />
                      <button
                        type="button"
                        onClick={() => setShowLoginPassword(!showLoginPassword)}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                      >
                        {showLoginPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </button>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => setShowForgotPassword(true)}
                    className="text-sm text-primary hover:underline"
                  >
                    Forgot your password?
                  </button>
                  
                  <Button 
                    type="submit" 
                    variant="pos"
                    className="w-full"
                    disabled={isLoading}
                  >
                    {isLoading ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Signing in...
                      </>
                    ) : (
                      'Sign In'
                    )}
                  </Button>
                </form>

              </TabsContent>

              <TabsContent value="cashier" className="mt-0">
                <CardTitle className="text-xl mb-1">Cashier Sign In</CardTitle>
                <CardDescription className="mb-6">
                  Use the business code, your username and PIN given by the owner.
                </CardDescription>

                <form onSubmit={handleCashierLogin} className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="c-code">Business Code</Label>
                    <div className="relative">
                      <Building2 className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                      <Input
                        id="c-code"
                        type="text"
                        placeholder="POS-XXXX"
                        className="pl-10 uppercase"
                        value={cashierCode}
                        onChange={(e) => setCashierCode(e.target.value.toUpperCase())}
                        required
                      />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="c-username">Username</Label>
                    <div className="relative">
                      <User className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                      <Input
                        id="c-username"
                        type="text"
                        placeholder="e.g. mary01"
                        className="pl-10 lowercase"
                        value={cashierUsername}
                        onChange={(e) => setCashierUsername(e.target.value.toLowerCase())}
                        required
                      />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="c-pin">PIN</Label>
                    <div className="relative">
                      <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                      <Input
                        id="c-pin"
                        type="password"
                        inputMode="numeric"
                        pattern="[0-9]*"
                        maxLength={6}
                        placeholder="••••"
                        className="pl-10"
                        value={cashierPin}
                        onChange={(e) => setCashierPin(e.target.value.replace(/\D/g, ''))}
                        required
                      />
                    </div>
                  </div>

                  <Button type="submit" variant="pos" className="w-full" disabled={isLoading}>
                    {isLoading ? (
                      <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Signing in…</>
                    ) : 'Sign In as Cashier'}
                  </Button>
                </form>
              </TabsContent>

              <TabsContent value="register" className="mt-0">
                <CardTitle className="text-xl mb-1">Create Account</CardTitle>
                <CardDescription className="mb-6">
                  Start your 3-day free trial today
                </CardDescription>
                
                <form onSubmit={handleRegister} className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="register-name">Full Name</Label>
                    <div className="relative">
                      <User className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                      <Input
                        id="register-name"
                        type="text"
                        placeholder="John Banda"
                        className="pl-10"
                        value={registerFullName}
                        onChange={(e) => setRegisterFullName(e.target.value)}
                        required
                      />
                    </div>
                  </div>
                  
                  <div className="space-y-2">
                    <Label htmlFor="register-business">Business Name</Label>
                    <div className="relative">
                      <Building2 className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                      <Input
                        id="register-business"
                        type="text"
                        placeholder="My Shop"
                        className="pl-10"
                        value={registerBusinessName}
                        onChange={(e) => setRegisterBusinessName(e.target.value)}
                        required
                      />
                    </div>
                  </div>
                  
                  <div className="space-y-2">
                    <Label htmlFor="register-email">Email</Label>
                    <div className="relative">
                      <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                      <Input
                        id="register-email"
                        type="email"
                        placeholder="you@example.com"
                        className="pl-10"
                        value={registerEmail}
                        onChange={(e) => setRegisterEmail(e.target.value)}
                        required
                      />
                    </div>
                  </div>
                  
                  <div className="space-y-2">
                    <Label htmlFor="register-password">Password</Label>
                    <div className="relative">
                      <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                      <Input
                        id="register-password"
                        type={showRegisterPassword ? "text" : "password"}
                        placeholder="••••••••"
                        className="pl-10 pr-10"
                        value={registerPassword}
                        onChange={(e) => setRegisterPassword(e.target.value)}
                        required
                        minLength={6}
                      />
                      <button
                        type="button"
                        onClick={() => setShowRegisterPassword(!showRegisterPassword)}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                      >
                        {showRegisterPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </button>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="register-phone">Phone Number (Optional)</Label>
                    <div className="relative">
                      <Phone className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                      <Input
                        id="register-phone"
                        type="tel"
                        placeholder="+260 97 123 4567"
                        className="pl-10"
                        value={registerPhone}
                        onChange={(e) => setRegisterPhone(e.target.value)}
                      />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="register-address">Business Address (Optional)</Label>
                    <div className="relative">
                      <MapPin className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                      <Input
                        id="register-address"
                        type="text"
                        placeholder="123 Main Street, Lusaka"
                        className="pl-10"
                        value={registerAddress}
                        onChange={(e) => setRegisterAddress(e.target.value)}
                      />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="register-business-type">Business Type</Label>
                    <div className="relative">
                      <Briefcase className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground z-10" />
                      <Select value={registerBusinessType} onValueChange={setRegisterBusinessType}>
                        <SelectTrigger className="pl-10">
                          <SelectValue placeholder="Select business type" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="retail">Retail / Shop</SelectItem>
                          <SelectItem value="service">Service Business</SelectItem>
                          <SelectItem value="hybrid">Both (Products & Services)</SelectItem>
                          <SelectItem value="restaurant">Restaurant / Food</SelectItem>
                          <SelectItem value="wholesale">Wholesale</SelectItem>
                          <SelectItem value="other">Other</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="register-affiliate">Affiliate Code (Optional)</Label>
                    <div className="relative">
                      <Gift className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                      <Input
                        id="register-affiliate"
                        type="text"
                        placeholder="e.g., ZAM-ABC123"
                        className="pl-10 uppercase"
                        value={affiliateCode}
                        onChange={(e) => setAffiliateCode(e.target.value.toUpperCase())}
                      />
                    </div>
                    <p className="text-xs text-muted-foreground">Have a referral code? Enter it here.</p>
                  </div>
                  
                  <Button 
                    type="submit" 
                    variant="pos-accent"
                    className="w-full"
                    disabled={isLoading}
                  >
                    {isLoading ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Creating account...
                      </>
                    ) : (
                      'Start Free Trial'
                    )}
                  </Button>
                </form>
                
                <p className="text-xs text-muted-foreground text-center mt-4">
                  3 days free, then starting from ZMW 200/month
                </p>

                <div className="mt-4 pt-4 border-t border-border text-center">
                  <p className="text-sm text-muted-foreground mb-2">Want to earn by referring businesses?</p>
                  <Button variant="outline" className="w-full" onClick={() => navigate('/affiliate-auth')}>
                    <Wallet className="h-4 w-4 mr-2" /> Become an Affiliate
                  </Button>
                </div>
              </TabsContent>
            </CardContent>
          </Tabs>
        </Card>

        <p className="text-xs text-muted-foreground text-center mt-4">
          <Link to="/privacy-policy" className="hover:text-primary">Privacy Policy</Link>
          <span className="mx-2">·</span>
          <span>© {new Date().getFullYear()} Sale Point</span>
        </p>
      </div>
    </div>
  );
};

export default Auth;
