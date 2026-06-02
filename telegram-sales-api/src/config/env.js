const dotenv = require('dotenv');

// SOLO cargar .env en desarrollo/local
if (process.env.NODE_ENV !== 'production') {
  dotenv.config();
}

const env = {
  NODE_ENV: process.env.NODE_ENV || 'development',
  PORT: process.env.PORT || 3001,
  DATABASE_URL: process.env.DATABASE_URL,
  JWT_SECRET: process.env.JWT_SECRET,
  ADMIN_USERNAME: process.env.ADMIN_USERNAME,
  ADMIN_PASSWORD_HASH: process.env.ADMIN_PASSWORD_HASH,
  APP_URL: process.env.APP_URL,
  TELEGRAM_BOT_WEBHOOK_SECRET: process.env.TELEGRAM_BOT_WEBHOOK_SECRET,
  DELIVERY_INITIAL_DELAY_MS: process.env.DELIVERY_INITIAL_DELAY_MS,
  DELIVERY_MESSAGE_INTERVAL_MS: process.env.DELIVERY_MESSAGE_INTERVAL_MS,
};

module.exports = env;
