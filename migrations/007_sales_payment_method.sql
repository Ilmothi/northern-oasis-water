-- ============================================================================
-- 007_sales_payment_method.sql
-- ============================================================================
-- Adds sales.method: how the amount paid AT point of sale was received
-- (cash / mpesa). Null when nothing was paid at the point of sale.
--
-- Context: the New Sale form now captures a partial "Amount Paid Now" instead
-- of a binary paid/unpaid toggle, and records the payment method alongside it.
-- Later repayments continue to carry their own method on the payments record.
--
-- APPLY THIS BEFORE MERGING the sale-form change: the app includes `method`
-- in every sales INSERT with a point-of-sale payment, which will be rejected
-- until this column exists (the sale is safely not saved and the rep is told,
-- but sales entry would effectively be blocked).
--
-- No RLS change: existing sales policies already cover all columns.
-- ============================================================================

alter table public.sales
  add column if not exists method text;
