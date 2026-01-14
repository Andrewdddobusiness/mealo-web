ALTER TABLE public.subscriptions
ADD COLUMN IF NOT EXISTS current_period_start timestamp;

