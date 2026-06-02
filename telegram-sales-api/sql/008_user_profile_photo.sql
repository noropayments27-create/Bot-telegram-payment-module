ALTER TABLE users
  ADD COLUMN IF NOT EXISTS telegram_photo_file_id text;
