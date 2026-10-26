-- Create a table to track pending Lenco payments on the server
-- This replaces the localStorage-based tracking to ensure subscriptions are extended
-- even if the user closes the tab or switches devices.

CREATE TABLE IF NOT EXISTS public.pending_payments (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    // Using text for reference to match Lenco's alphanumeric references
    lenco_reference text NOT NULL UNIQUE,
    business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
    months integer NOT NULL CHECK (months >= 1 AND months <= 24),
    amount numeric NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    verified_at timestamp with time zone,
    status text DEFAULT 'pending', -- 'pending', 'completed', 'failed'
    
    CONSTRAINT fk_business FOREIGN KEY (business_id) REFERENCES public.businesses(id)
);

-- Enable RLS
ALTER TABLE public.pending_payments ENABLE ROW LEVEL SECURITY;

-- Policies
CREATE POLICY "Users can view their own pending payments"
  ON public.pending_payments FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.businesses 
      WHERE id = pending_payments.business_id 
      AND user_id = auth.uid()
    )
  );

-- We use a service role for the background worker, 
-- but owners can insert their own pending payment requests.
CREATE POLICY "Users can insert their own pending payments"
  ON public.pending_payments FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.businesses 
      WHERE id = pending_payments.business_id 
      AND user_id = auth.uid()
    )
  );

CREATE INDEX idx_pending_payments_reference ON public.pending_payments(lenco_reference);
CREATE INDEX idx_pending_payments_status ON public.pending_payments(status);
