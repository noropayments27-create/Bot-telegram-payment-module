ALTER TABLE bot_assets
  ADD COLUMN IF NOT EXISTS main_image_url text,
  ADD COLUMN IF NOT EXISTS affiliate_panel_image_url text,
  ADD COLUMN IF NOT EXISTS cart_image_url text,
  ADD COLUMN IF NOT EXISTS community_image_url text,
  ADD COLUMN IF NOT EXISTS shop_section_image_url text,
  ADD COLUMN IF NOT EXISTS support_image_url text,
  ADD COLUMN IF NOT EXISTS payment_methods_image_url text;
