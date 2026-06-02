const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');

const dbRoutes = require('./routes/db.routes');
const healthRoutes = require('./routes/health.routes');
const usersRoutes = require('./modules/users/users.routes');
const productsRoutes = require('./modules/products/products.routes');
const ordersRoutes = require('./modules/orders/orders.routes');
const cartRoutes = require('./modules/cart/cart.routes');
const botRoutes = require('./routes/bot.routes');
const adminRoutes = require('./routes/admin.routes');
const ticketsRoutes = require('./routes/tickets.routes');
const errorMiddleware = require('./middlewares/error.middleware');
const adminRateLimit = require('./middlewares/adminRateLimit');

const app = express();

// Seguridad
app.use(helmet());

// ✅ CORS (MVP Admin Panel)
// - Permite llamadas desde http://localhost:3000
// - Permite header Authorization (para endpoints /admin/*)
// - Expone Content-Disposition (para descarga de screenshot)
const allowedOrigins = new Set([
  "http://localhost:3000",
  "http://127.0.0.1:3000",
]);

const extraOrigins = String(process.env.ADMIN_ORIGIN || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

for (const origin of extraOrigins) {
  allowedOrigins.add(origin);
}

const corsOptions = {
  origin(origin, callback) {
    if (!origin) {
      return callback(null, true);
    }
    if (allowedOrigins.has(origin)) {
      return callback(null, true);
    }
    try {
      const url = new URL(origin);
      const isLocalhost =
        (url.hostname === "localhost" || url.hostname === "127.0.0.1")
        && url.protocol === "http:";
      if (isLocalhost) {
        return callback(null, true);
      }
    } catch (error) {
      // Ignore invalid origins and reject below.
    }
    return callback(new Error("Not allowed by CORS"));
  },
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "x-admin-key", "x-bot-secret"],
  exposedHeaders: ["Content-Disposition"],
  credentials: false,
};

// Aplica CORS a todas las requests
app.use(cors(corsOptions));
// Responde bien a TODOS los preflight (OPTIONS)
app.options('*', cors(corsOptions));

// Body + logs
app.use(express.json({ limit: "12mb" }));
if (process.env.API_LOG_REQUESTS !== "false") {
  app.use(morgan('dev'));
}

// Rutas
app.use('/health', healthRoutes);
app.use('/health', dbRoutes);
app.use('/users', usersRoutes);
app.use('/products', productsRoutes);
app.use('/orders', ordersRoutes);
app.use('/bot/cart', cartRoutes);
app.use('/bot', botRoutes);
app.use('/admin', adminRateLimit, adminRoutes);
app.use('/tickets', ticketsRoutes);

// 404
app.use((req, res) => {
  res.status(404).json({ ok: false, error: 'Not Found' });
});

// Error middleware
app.use(errorMiddleware);

module.exports = app;
