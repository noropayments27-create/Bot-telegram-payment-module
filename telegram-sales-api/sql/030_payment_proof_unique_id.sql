ALTER TABLE order_payments
  ADD COLUMN IF NOT EXISTS screenshot_unique_id text;

CREATE INDEX IF NOT EXISTS idx_order_payments_screenshot_unique_id
  ON order_payments(screenshot_unique_id);

ALTER TABLE ticket_messages
  ADD COLUMN IF NOT EXISTS telegram_file_unique_id text;

CREATE INDEX IF NOT EXISTS idx_ticket_messages_file_unique_id
  ON ticket_messages(telegram_file_unique_id);
