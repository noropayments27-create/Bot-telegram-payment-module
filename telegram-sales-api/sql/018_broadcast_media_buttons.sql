ALTER TABLE broadcasts
  ADD COLUMN IF NOT EXISTS image_path text,
  ADD COLUMN IF NOT EXISTS image_filename text,
  ADD COLUMN IF NOT EXISTS image_mime text,
  ADD COLUMN IF NOT EXISTS buttons jsonb;
