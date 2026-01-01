-- Feedback board tables (submissions, votes, comments)
-- Safe to run multiple times.

CREATE TABLE IF NOT EXISTS public.feedback_submissions (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  title text NOT NULL,
  description text NOT NULL,
  type text NOT NULL,
  status text NOT NULL DEFAULT 'open',
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

-- Edit tracking (safe to run multiple times)
ALTER TABLE public.feedback_submissions
  ADD COLUMN IF NOT EXISTS edit_count integer NOT NULL DEFAULT 0;

ALTER TABLE public.feedback_submissions
  ADD COLUMN IF NOT EXISTS last_edited_at timestamp;

CREATE INDEX IF NOT EXISTS feedback_submissions_created_at_idx
  ON public.feedback_submissions (created_at);

CREATE INDEX IF NOT EXISTS feedback_submissions_user_id_idx
  ON public.feedback_submissions (user_id);

CREATE INDEX IF NOT EXISTS feedback_submissions_type_idx
  ON public.feedback_submissions (type);

CREATE INDEX IF NOT EXISTS feedback_submissions_status_idx
  ON public.feedback_submissions (status);

CREATE TABLE IF NOT EXISTS public.feedback_votes (
  id text PRIMARY KEY,
  submission_id text NOT NULL REFERENCES public.feedback_submissions(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS feedback_votes_submission_id_idx
  ON public.feedback_votes (submission_id);

CREATE INDEX IF NOT EXISTS feedback_votes_user_id_idx
  ON public.feedback_votes (user_id);

CREATE UNIQUE INDEX IF NOT EXISTS feedback_votes_submission_id_user_id_uniq
  ON public.feedback_votes (submission_id, user_id);

CREATE TABLE IF NOT EXISTS public.feedback_comments (
  id text PRIMARY KEY,
  submission_id text NOT NULL REFERENCES public.feedback_submissions(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  body text NOT NULL,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS feedback_comments_submission_id_idx
  ON public.feedback_comments (submission_id);

CREATE INDEX IF NOT EXISTS feedback_comments_created_at_idx
  ON public.feedback_comments (created_at);
