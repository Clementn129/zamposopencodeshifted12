-- Stock movements ledger + trigger

CREATE TABLE IF NOT EXISTS public.stock_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  delta integer NOT NULL,
  quantity_after integer NOT NULL,
  movement_type text NOT NULL CHECK (movement_type IN (
    'sale','sale_return','sale_delete','delivery_note',
    'adjustment_add','adjustment_remove','manual_edit','import',
    'variant_create','product_create','restoration','other'
  )),
  reference_type text NULL,
  reference_id uuid NULL,
  note text NULL,
  actor_id uuid NULL,
  actor_name text NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_stock_movements_business_created ON public.stock_movements (business_id, created_at);
CREATE INDEX IF NOT EXISTS idx_stock_movements_product_created ON public.stock_movements (product_id, created_at);
CREATE INDEX IF NOT EXISTS idx_stock_movements_ref ON public.stock_movements (reference_type, reference_id);

COMMENT ON TABLE public.stock_movements IS 'Immutable audit trail of every products.stock change';
COMMENT ON COLUMN public.stock_movements.delta IS 'Positive = in, negative = out';
COMMENT ON COLUMN public.stock_movements.quantity_after IS 'products.stock value immediately after this change';

ALTER TABLE public.stock_movements ENABLE ROW LEVEL SECURITY;

CREATE POLICY IF NOT EXISTS sm_owner_all ON public.stock_movements
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM businesses b WHERE b.id = business_id AND b.user_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM businesses b WHERE b.id = business_id AND b.user_id = auth.uid()));

CREATE POLICY IF NOT EXISTS sm_read_all_members ON public.stock_movements
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM business_members bm
    JOIN user_roles ur ON ur.user_id = auth.uid() AND ur.business_id = bm.business_id
    WHERE bm.business_id = stock_movements.business_id AND bm.user_id = auth.uid()
  ));

