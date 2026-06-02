-- Seed products for BOT de ventas (demo)
-- Inserts 45 active products across SHOP, METODOS, VIP, WEB.

INSERT INTO products (sku_key, name, description, price, is_active, delivery_type, delivery_payload)
VALUES (
  'shop_tarjetas',
  'SHOP 01 - 💳 Venta de Tarjetas',
  'Producto de prueba',
  20.00,
  true,
  'LINK',
  '{"url":"https://example.com/entrega-demo","note":"Entrega de prueba"}'::jsonb
)
ON CONFLICT (sku_key)
DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  price = EXCLUDED.price,
  is_active = EXCLUDED.is_active,
  delivery_type = EXCLUDED.delivery_type,
  delivery_payload = EXCLUDED.delivery_payload,
  updated_at = now();

INSERT INTO products (sku_key, name, description, price, is_active, delivery_type, delivery_payload)
VALUES (
  'shop_links_ccs',
  'SHOP 02 - 🔗 Links de CCS Shop',
  'Producto de prueba',
  20.00,
  true,
  'LINK',
  '{"url":"https://example.com/entrega-demo","note":"Entrega de prueba"}'::jsonb
)
ON CONFLICT (sku_key)
DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  price = EXCLUDED.price,
  is_active = EXCLUDED.is_active,
  delivery_type = EXCLUDED.delivery_type,
  delivery_payload = EXCLUDED.delivery_payload,
  updated_at = now();

INSERT INTO products (sku_key, name, description, price, is_active, delivery_type, delivery_payload)
VALUES (
  'shop_foros_carding',
  'SHOP 03 - 🕵️ Foros de Carding',
  'Producto de prueba',
  20.00,
  true,
  'LINK',
  '{"url":"https://example.com/entrega-demo","note":"Entrega de prueba"}'::jsonb
)
ON CONFLICT (sku_key)
DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  price = EXCLUDED.price,
  is_active = EXCLUDED.is_active,
  delivery_type = EXCLUDED.delivery_type,
  delivery_payload = EXCLUDED.delivery_payload,
  updated_at = now();

INSERT INTO products (sku_key, name, description, price, is_active, delivery_type, delivery_payload)
VALUES (
  'shop_paneles_smm',
  'SHOP 04 - 📊 Paneles SMM',
  'Producto de prueba',
  20.00,
  true,
  'LINK',
  '{"url":"https://example.com/entrega-demo","note":"Entrega de prueba"}'::jsonb
)
ON CONFLICT (sku_key)
DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  price = EXCLUDED.price,
  is_active = EXCLUDED.is_active,
  delivery_type = EXCLUDED.delivery_type,
  delivery_payload = EXCLUDED.delivery_payload,
  updated_at = now();

INSERT INTO products (sku_key, name, description, price, is_active, delivery_type, delivery_payload)
VALUES (
  'shop_paneles_sms',
  'SHOP 05 - 📲 Paneles SMS',
  'Producto de prueba',
  20.00,
  true,
  'LINK',
  '{"url":"https://example.com/entrega-demo","note":"Entrega de prueba"}'::jsonb
)
ON CONFLICT (sku_key)
DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  price = EXCLUDED.price,
  is_active = EXCLUDED.is_active,
  delivery_type = EXCLUDED.delivery_type,
  delivery_payload = EXCLUDED.delivery_payload,
  updated_at = now();

INSERT INTO products (sku_key, name, description, price, is_active, delivery_type, delivery_payload)
VALUES (
  'shop_paneles_gift',
  'SHOP 06 - 🎁 Paneles Gift Card',
  'Producto de prueba',
  20.00,
  true,
  'LINK',
  '{"url":"https://example.com/entrega-demo","note":"Entrega de prueba"}'::jsonb
)
ON CONFLICT (sku_key)
DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  price = EXCLUDED.price,
  is_active = EXCLUDED.is_active,
  delivery_type = EXCLUDED.delivery_type,
  delivery_payload = EXCLUDED.delivery_payload,
  updated_at = now();

INSERT INTO products (sku_key, name, description, price, is_active, delivery_type, delivery_payload)
VALUES (
  'shop_paneles_streaming',
  'SHOP 07 - 🎬 Paneles Streaming',
  'Producto de prueba',
  20.00,
  true,
  'LINK',
  '{"url":"https://example.com/entrega-demo","note":"Entrega de prueba"}'::jsonb
)
ON CONFLICT (sku_key)
DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  price = EXCLUDED.price,
  is_active = EXCLUDED.is_active,
  delivery_type = EXCLUDED.delivery_type,
  delivery_payload = EXCLUDED.delivery_payload,
  updated_at = now();

INSERT INTO products (sku_key, name, description, price, is_active, delivery_type, delivery_payload)
VALUES (
  'shop_paneles_juegos',
  'SHOP 08 - 🎮 Paneles de Juegos',
  'Producto de prueba',
  20.00,
  true,
  'LINK',
  '{"url":"https://example.com/entrega-demo","note":"Entrega de prueba"}'::jsonb
)
ON CONFLICT (sku_key)
DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  price = EXCLUDED.price,
  is_active = EXCLUDED.is_active,
  delivery_type = EXCLUDED.delivery_type,
  delivery_payload = EXCLUDED.delivery_payload,
  updated_at = now();

INSERT INTO products (sku_key, name, description, price, is_active, delivery_type, delivery_payload)
VALUES (
  'shop_emails_temporales',
  'SHOP 09 - 📧 Emails Temporales',
  'Producto de prueba',
  20.00,
  true,
  'LINK',
  '{"url":"https://example.com/entrega-demo","note":"Entrega de prueba"}'::jsonb
)
ON CONFLICT (sku_key)
DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  price = EXCLUDED.price,
  is_active = EXCLUDED.is_active,
  delivery_type = EXCLUDED.delivery_type,
  delivery_payload = EXCLUDED.delivery_payload,
  updated_at = now();

INSERT INTO products (sku_key, name, description, price, is_active, delivery_type, delivery_payload)
VALUES (
  'shop_hosting_dominios',
  'SHOP 10 - 🌐 Hosting y Dominios',
  'Producto de prueba',
  20.00,
  true,
  'LINK',
  '{"url":"https://example.com/entrega-demo","note":"Entrega de prueba"}'::jsonb
)
ON CONFLICT (sku_key)
DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  price = EXCLUDED.price,
  is_active = EXCLUDED.is_active,
  delivery_type = EXCLUDED.delivery_type,
  delivery_payload = EXCLUDED.delivery_payload,
  updated_at = now();

INSERT INTO products (sku_key, name, description, price, is_active, delivery_type, delivery_payload)
VALUES (
  'shop_logs_bases',
  'SHOP 11 - 🧾 Logs y Bases de Datos',
  'Producto de prueba',
  20.00,
  true,
  'LINK',
  '{"url":"https://example.com/entrega-demo","note":"Entrega de prueba"}'::jsonb
)
ON CONFLICT (sku_key)
DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  price = EXCLUDED.price,
  is_active = EXCLUDED.is_active,
  delivery_type = EXCLUDED.delivery_type,
  delivery_payload = EXCLUDED.delivery_payload,
  updated_at = now();

INSERT INTO products (sku_key, name, description, price, is_active, delivery_type, delivery_payload)
VALUES (
  'shop_vpn_premium',
  'SHOP 12 - 🛡️ VPN Premium',
  'Producto de prueba',
  20.00,
  true,
  'LINK',
  '{"url":"https://example.com/entrega-demo","note":"Entrega de prueba"}'::jsonb
)
ON CONFLICT (sku_key)
DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  price = EXCLUDED.price,
  is_active = EXCLUDED.is_active,
  delivery_type = EXCLUDED.delivery_type,
  delivery_payload = EXCLUDED.delivery_payload,
  updated_at = now();

INSERT INTO products (sku_key, name, description, price, is_active, delivery_type, delivery_payload)
VALUES (
  'shop_herramientas_digitales',
  'SHOP 13 - 🧰 Herramientas Digitales',
  'Producto de prueba',
  20.00,
  true,
  'LINK',
  '{"url":"https://example.com/entrega-demo","note":"Entrega de prueba"}'::jsonb
)
ON CONFLICT (sku_key)
DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  price = EXCLUDED.price,
  is_active = EXCLUDED.is_active,
  delivery_type = EXCLUDED.delivery_type,
  delivery_payload = EXCLUDED.delivery_payload,
  updated_at = now();

INSERT INTO products (sku_key, name, description, price, is_active, delivery_type, delivery_payload)
VALUES (
  'shop_descargas_premium',
  'SHOP 14 - 📥 Descargas Premium',
  'Producto de prueba',
  20.00,
  true,
  'LINK',
  '{"url":"https://example.com/entrega-demo","note":"Entrega de prueba"}'::jsonb
)
ON CONFLICT (sku_key)
DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  price = EXCLUDED.price,
  is_active = EXCLUDED.is_active,
  delivery_type = EXCLUDED.delivery_type,
  delivery_payload = EXCLUDED.delivery_payload,
  updated_at = now();

INSERT INTO products (sku_key, name, description, price, is_active, delivery_type, delivery_payload)
VALUES (
  'shop_bots_automatizados',
  'SHOP 15 - 🤖 Bots Automatizados',
  'Producto de prueba',
  20.00,
  true,
  'LINK',
  '{"url":"https://example.com/entrega-demo","note":"Entrega de prueba"}'::jsonb
)
ON CONFLICT (sku_key)
DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  price = EXCLUDED.price,
  is_active = EXCLUDED.is_active,
  delivery_type = EXCLUDED.delivery_type,
  delivery_payload = EXCLUDED.delivery_payload,
  updated_at = now();

INSERT INTO products (sku_key, name, description, price, is_active, delivery_type, delivery_payload)
VALUES (
  'shop_servicios_freelance',
  'SHOP 16 - 💼 Servicios Freelance',
  'Producto de prueba',
  20.00,
  true,
  'LINK',
  '{"url":"https://example.com/entrega-demo","note":"Entrega de prueba"}'::jsonb
)
ON CONFLICT (sku_key)
DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  price = EXCLUDED.price,
  is_active = EXCLUDED.is_active,
  delivery_type = EXCLUDED.delivery_type,
  delivery_payload = EXCLUDED.delivery_payload,
  updated_at = now();

INSERT INTO products (sku_key, name, description, price, is_active, delivery_type, delivery_payload)
VALUES (
  'shop_cursos_tutoriales',
  'SHOP 17 - 🧑‍💻 Cursos y Tutoriales',
  'Producto de prueba',
  20.00,
  true,
  'LINK',
  '{"url":"https://example.com/entrega-demo","note":"Entrega de prueba"}'::jsonb
)
ON CONFLICT (sku_key)
DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  price = EXCLUDED.price,
  is_active = EXCLUDED.is_active,
  delivery_type = EXCLUDED.delivery_type,
  delivery_payload = EXCLUDED.delivery_payload,
  updated_at = now();

INSERT INTO products (sku_key, name, description, price, is_active, delivery_type, delivery_payload)
VALUES (
  'shop_cuentas_verificadas',
  'SHOP 18 - 🔐 Cuentas Verificadas',
  'Producto de prueba',
  20.00,
  true,
  'LINK',
  '{"url":"https://example.com/entrega-demo","note":"Entrega de prueba"}'::jsonb
)
ON CONFLICT (sku_key)
DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  price = EXCLUDED.price,
  is_active = EXCLUDED.is_active,
  delivery_type = EXCLUDED.delivery_type,
  delivery_payload = EXCLUDED.delivery_payload,
  updated_at = now();

INSERT INTO products (sku_key, name, description, price, is_active, delivery_type, delivery_payload)
VALUES (
  'metodos_flux',
  'METODOS 01 - ✅ Método Flux',
  'Producto de prueba',
  20.00,
  true,
  'LINK',
  '{"url":"https://example.com/entrega-demo","note":"Entrega de prueba"}'::jsonb
)
ON CONFLICT (sku_key)
DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  price = EXCLUDED.price,
  is_active = EXCLUDED.is_active,
  delivery_type = EXCLUDED.delivery_type,
  delivery_payload = EXCLUDED.delivery_payload,
  updated_at = now();

INSERT INTO products (sku_key, name, description, price, is_active, delivery_type, delivery_payload)
VALUES (
  'metodos_atlas',
  'METODOS 02 - ✅ Método Atlas',
  'Producto de prueba',
  20.00,
  true,
  'LINK',
  '{"url":"https://example.com/entrega-demo","note":"Entrega de prueba"}'::jsonb
)
ON CONFLICT (sku_key)
DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  price = EXCLUDED.price,
  is_active = EXCLUDED.is_active,
  delivery_type = EXCLUDED.delivery_type,
  delivery_payload = EXCLUDED.delivery_payload,
  updated_at = now();

INSERT INTO products (sku_key, name, description, price, is_active, delivery_type, delivery_payload)
VALUES (
  'metodos_prisma',
  'METODOS 03 - ✅ Método Prisma',
  'Producto de prueba',
  20.00,
  true,
  'LINK',
  '{"url":"https://example.com/entrega-demo","note":"Entrega de prueba"}'::jsonb
)
ON CONFLICT (sku_key)
DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  price = EXCLUDED.price,
  is_active = EXCLUDED.is_active,
  delivery_type = EXCLUDED.delivery_type,
  delivery_payload = EXCLUDED.delivery_payload,
  updated_at = now();

INSERT INTO products (sku_key, name, description, price, is_active, delivery_type, delivery_payload)
VALUES (
  'metodos_vector',
  'METODOS 04 - ✅ Método Vector',
  'Producto de prueba',
  20.00,
  true,
  'LINK',
  '{"url":"https://example.com/entrega-demo","note":"Entrega de prueba"}'::jsonb
)
ON CONFLICT (sku_key)
DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  price = EXCLUDED.price,
  is_active = EXCLUDED.is_active,
  delivery_type = EXCLUDED.delivery_type,
  delivery_payload = EXCLUDED.delivery_payload,
  updated_at = now();

INSERT INTO products (sku_key, name, description, price, is_active, delivery_type, delivery_payload)
VALUES (
  'metodos_delta',
  'METODOS 05 - ✅ Método Delta',
  'Producto de prueba',
  20.00,
  true,
  'LINK',
  '{"url":"https://example.com/entrega-demo","note":"Entrega de prueba"}'::jsonb
)
ON CONFLICT (sku_key)
DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  price = EXCLUDED.price,
  is_active = EXCLUDED.is_active,
  delivery_type = EXCLUDED.delivery_type,
  delivery_payload = EXCLUDED.delivery_payload,
  updated_at = now();

INSERT INTO products (sku_key, name, description, price, is_active, delivery_type, delivery_payload)
VALUES (
  'metodos_pulse',
  'METODOS 06 - ✅ Método Pulse',
  'Producto de prueba',
  20.00,
  true,
  'LINK',
  '{"url":"https://example.com/entrega-demo","note":"Entrega de prueba"}'::jsonb
)
ON CONFLICT (sku_key)
DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  price = EXCLUDED.price,
  is_active = EXCLUDED.is_active,
  delivery_type = EXCLUDED.delivery_type,
  delivery_payload = EXCLUDED.delivery_payload,
  updated_at = now();

INSERT INTO products (sku_key, name, description, price, is_active, delivery_type, delivery_payload)
VALUES (
  'metodos_nova',
  'METODOS 07 - ✅ Método Nova',
  'Producto de prueba',
  20.00,
  true,
  'LINK',
  '{"url":"https://example.com/entrega-demo","note":"Entrega de prueba"}'::jsonb
)
ON CONFLICT (sku_key)
DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  price = EXCLUDED.price,
  is_active = EXCLUDED.is_active,
  delivery_type = EXCLUDED.delivery_type,
  delivery_payload = EXCLUDED.delivery_payload,
  updated_at = now();

INSERT INTO products (sku_key, name, description, price, is_active, delivery_type, delivery_payload)
VALUES (
  'metodos_sigma',
  'METODOS 08 - ✅ Método Sigma',
  'Producto de prueba',
  20.00,
  true,
  'LINK',
  '{"url":"https://example.com/entrega-demo","note":"Entrega de prueba"}'::jsonb
)
ON CONFLICT (sku_key)
DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  price = EXCLUDED.price,
  is_active = EXCLUDED.is_active,
  delivery_type = EXCLUDED.delivery_type,
  delivery_payload = EXCLUDED.delivery_payload,
  updated_at = now();

INSERT INTO products (sku_key, name, description, price, is_active, delivery_type, delivery_payload)
VALUES (
  'metodos_orion',
  'METODOS 09 - ✅ Método Orion',
  'Producto de prueba',
  20.00,
  true,
  'LINK',
  '{"url":"https://example.com/entrega-demo","note":"Entrega de prueba"}'::jsonb
)
ON CONFLICT (sku_key)
DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  price = EXCLUDED.price,
  is_active = EXCLUDED.is_active,
  delivery_type = EXCLUDED.delivery_type,
  delivery_payload = EXCLUDED.delivery_payload,
  updated_at = now();

INSERT INTO products (sku_key, name, description, price, is_active, delivery_type, delivery_payload)
VALUES (
  'vip_aurora',
  'VIP 01 - 💬 VIP Aurora',
  'Producto de prueba',
  20.00,
  true,
  'LINK',
  '{"url":"https://example.com/entrega-demo","note":"Entrega de prueba"}'::jsonb
)
ON CONFLICT (sku_key)
DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  price = EXCLUDED.price,
  is_active = EXCLUDED.is_active,
  delivery_type = EXCLUDED.delivery_type,
  delivery_payload = EXCLUDED.delivery_payload,
  updated_at = now();

INSERT INTO products (sku_key, name, description, price, is_active, delivery_type, delivery_payload)
VALUES (
  'vip_nexus',
  'VIP 02 - 💬 VIP Nexus',
  'Producto de prueba',
  20.00,
  true,
  'LINK',
  '{"url":"https://example.com/entrega-demo","note":"Entrega de prueba"}'::jsonb
)
ON CONFLICT (sku_key)
DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  price = EXCLUDED.price,
  is_active = EXCLUDED.is_active,
  delivery_type = EXCLUDED.delivery_type,
  delivery_payload = EXCLUDED.delivery_payload,
  updated_at = now();

INSERT INTO products (sku_key, name, description, price, is_active, delivery_type, delivery_payload)
VALUES (
  'vip_zenith',
  'VIP 03 - 💬 VIP Zenith',
  'Producto de prueba',
  20.00,
  true,
  'LINK',
  '{"url":"https://example.com/entrega-demo","note":"Entrega de prueba"}'::jsonb
)
ON CONFLICT (sku_key)
DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  price = EXCLUDED.price,
  is_active = EXCLUDED.is_active,
  delivery_type = EXCLUDED.delivery_type,
  delivery_payload = EXCLUDED.delivery_payload,
  updated_at = now();

INSERT INTO products (sku_key, name, description, price, is_active, delivery_type, delivery_payload)
VALUES (
  'vip_pulse',
  'VIP 04 - 💬 VIP Pulse',
  'Producto de prueba',
  20.00,
  true,
  'LINK',
  '{"url":"https://example.com/entrega-demo","note":"Entrega de prueba"}'::jsonb
)
ON CONFLICT (sku_key)
DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  price = EXCLUDED.price,
  is_active = EXCLUDED.is_active,
  delivery_type = EXCLUDED.delivery_type,
  delivery_payload = EXCLUDED.delivery_payload,
  updated_at = now();

INSERT INTO products (sku_key, name, description, price, is_active, delivery_type, delivery_payload)
VALUES (
  'vip_prime',
  'VIP 05 - 💬 VIP Prime',
  'Producto de prueba',
  20.00,
  true,
  'LINK',
  '{"url":"https://example.com/entrega-demo","note":"Entrega de prueba"}'::jsonb
)
ON CONFLICT (sku_key)
DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  price = EXCLUDED.price,
  is_active = EXCLUDED.is_active,
  delivery_type = EXCLUDED.delivery_type,
  delivery_payload = EXCLUDED.delivery_payload,
  updated_at = now();

INSERT INTO products (sku_key, name, description, price, is_active, delivery_type, delivery_payload)
VALUES (
  'vip_terra',
  'VIP 06 - 💬 VIP Terra',
  'Producto de prueba',
  20.00,
  true,
  'LINK',
  '{"url":"https://example.com/entrega-demo","note":"Entrega de prueba"}'::jsonb
)
ON CONFLICT (sku_key)
DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  price = EXCLUDED.price,
  is_active = EXCLUDED.is_active,
  delivery_type = EXCLUDED.delivery_type,
  delivery_payload = EXCLUDED.delivery_payload,
  updated_at = now();

INSERT INTO products (sku_key, name, description, price, is_active, delivery_type, delivery_payload)
VALUES (
  'vip_sigma',
  'VIP 07 - 💬 VIP Sigma',
  'Producto de prueba',
  20.00,
  true,
  'LINK',
  '{"url":"https://example.com/entrega-demo","note":"Entrega de prueba"}'::jsonb
)
ON CONFLICT (sku_key)
DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  price = EXCLUDED.price,
  is_active = EXCLUDED.is_active,
  delivery_type = EXCLUDED.delivery_type,
  delivery_payload = EXCLUDED.delivery_payload,
  updated_at = now();

INSERT INTO products (sku_key, name, description, price, is_active, delivery_type, delivery_payload)
VALUES (
  'vip_stellar',
  'VIP 08 - 💬 VIP Stellar',
  'Producto de prueba',
  20.00,
  true,
  'LINK',
  '{"url":"https://example.com/entrega-demo","note":"Entrega de prueba"}'::jsonb
)
ON CONFLICT (sku_key)
DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  price = EXCLUDED.price,
  is_active = EXCLUDED.is_active,
  delivery_type = EXCLUDED.delivery_type,
  delivery_payload = EXCLUDED.delivery_payload,
  updated_at = now();

INSERT INTO products (sku_key, name, description, price, is_active, delivery_type, delivery_payload)
VALUES (
  'vip_omega',
  'VIP 09 - 💬 VIP Omega',
  'Producto de prueba',
  20.00,
  true,
  'LINK',
  '{"url":"https://example.com/entrega-demo","note":"Entrega de prueba"}'::jsonb
)
ON CONFLICT (sku_key)
DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  price = EXCLUDED.price,
  is_active = EXCLUDED.is_active,
  delivery_type = EXCLUDED.delivery_type,
  delivery_payload = EXCLUDED.delivery_payload,
  updated_at = now();

INSERT INTO products (sku_key, name, description, price, is_active, delivery_type, delivery_payload)
VALUES (
  'web_pack_landing',
  'WEB 01 - 💻 Pack Landing Pro',
  'Producto de prueba',
  20.00,
  true,
  'LINK',
  '{"url":"https://example.com/entrega-demo","note":"Entrega de prueba"}'::jsonb
)
ON CONFLICT (sku_key)
DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  price = EXCLUDED.price,
  is_active = EXCLUDED.is_active,
  delivery_type = EXCLUDED.delivery_type,
  delivery_payload = EXCLUDED.delivery_payload,
  updated_at = now();

INSERT INTO products (sku_key, name, description, price, is_active, delivery_type, delivery_payload)
VALUES (
  'web_script_auto',
  'WEB 02 - 💻 Script Auto',
  'Producto de prueba',
  20.00,
  true,
  'LINK',
  '{"url":"https://example.com/entrega-demo","note":"Entrega de prueba"}'::jsonb
)
ON CONFLICT (sku_key)
DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  price = EXCLUDED.price,
  is_active = EXCLUDED.is_active,
  delivery_type = EXCLUDED.delivery_type,
  delivery_payload = EXCLUDED.delivery_payload,
  updated_at = now();

INSERT INTO products (sku_key, name, description, price, is_active, delivery_type, delivery_payload)
VALUES (
  'web_toolkit_seo',
  'WEB 03 - 💻 Toolkit SEO',
  'Producto de prueba',
  20.00,
  true,
  'LINK',
  '{"url":"https://example.com/entrega-demo","note":"Entrega de prueba"}'::jsonb
)
ON CONFLICT (sku_key)
DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  price = EXCLUDED.price,
  is_active = EXCLUDED.is_active,
  delivery_type = EXCLUDED.delivery_type,
  delivery_payload = EXCLUDED.delivery_payload,
  updated_at = now();

INSERT INTO products (sku_key, name, description, price, is_active, delivery_type, delivery_payload)
VALUES (
  'web_panel_lite',
  'WEB 04 - 💻 Panel Web Lite',
  'Producto de prueba',
  20.00,
  true,
  'LINK',
  '{"url":"https://example.com/entrega-demo","note":"Entrega de prueba"}'::jsonb
)
ON CONFLICT (sku_key)
DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  price = EXCLUDED.price,
  is_active = EXCLUDED.is_active,
  delivery_type = EXCLUDED.delivery_type,
  delivery_payload = EXCLUDED.delivery_payload,
  updated_at = now();

INSERT INTO products (sku_key, name, description, price, is_active, delivery_type, delivery_payload)
VALUES (
  'web_starter',
  'WEB 05 - 💻 Web Starter',
  'Producto de prueba',
  20.00,
  true,
  'LINK',
  '{"url":"https://example.com/entrega-demo","note":"Entrega de prueba"}'::jsonb
)
ON CONFLICT (sku_key)
DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  price = EXCLUDED.price,
  is_active = EXCLUDED.is_active,
  delivery_type = EXCLUDED.delivery_type,
  delivery_payload = EXCLUDED.delivery_payload,
  updated_at = now();

INSERT INTO products (sku_key, name, description, price, is_active, delivery_type, delivery_payload)
VALUES (
  'web_bot',
  'WEB 06 - 💻 Bot Web',
  'Producto de prueba',
  20.00,
  true,
  'LINK',
  '{"url":"https://example.com/entrega-demo","note":"Entrega de prueba"}'::jsonb
)
ON CONFLICT (sku_key)
DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  price = EXCLUDED.price,
  is_active = EXCLUDED.is_active,
  delivery_type = EXCLUDED.delivery_type,
  delivery_payload = EXCLUDED.delivery_payload,
  updated_at = now();

INSERT INTO products (sku_key, name, description, price, is_active, delivery_type, delivery_payload)
VALUES (
  'web_pack_ui',
  'WEB 07 - 💻 Pack UI',
  'Producto de prueba',
  20.00,
  true,
  'LINK',
  '{"url":"https://example.com/entrega-demo","note":"Entrega de prueba"}'::jsonb
)
ON CONFLICT (sku_key)
DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  price = EXCLUDED.price,
  is_active = EXCLUDED.is_active,
  delivery_type = EXCLUDED.delivery_type,
  delivery_payload = EXCLUDED.delivery_payload,
  updated_at = now();

INSERT INTO products (sku_key, name, description, price, is_active, delivery_type, delivery_payload)
VALUES (
  'web_web_plus',
  'WEB 08 - 💻 Web Plus',
  'Producto de prueba',
  20.00,
  true,
  'LINK',
  '{"url":"https://example.com/entrega-demo","note":"Entrega de prueba"}'::jsonb
)
ON CONFLICT (sku_key)
DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  price = EXCLUDED.price,
  is_active = EXCLUDED.is_active,
  delivery_type = EXCLUDED.delivery_type,
  delivery_payload = EXCLUDED.delivery_payload,
  updated_at = now();

INSERT INTO products (sku_key, name, description, price, is_active, delivery_type, delivery_payload)
VALUES (
  'web_web_master',
  'WEB 09 - 💻 Web Master',
  'Producto de prueba',
  20.00,
  true,
  'LINK',
  '{"url":"https://example.com/entrega-demo","note":"Entrega de prueba"}'::jsonb
)
ON CONFLICT (sku_key)
DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  price = EXCLUDED.price,
  is_active = EXCLUDED.is_active,
  delivery_type = EXCLUDED.delivery_type,
  delivery_payload = EXCLUDED.delivery_payload,
  updated_at = now();
