const app = require('./app');
const env = require('./config/env');
const { connectDb, getPool } = require('./db');
const { startOrderExpiryJob } = require('./services/orderExpiryJob');
const { ensureOrderNumberSchema } = require('./services/orderNumbers');
const { ensureUserWalletSchema, ensureWalletGiftSchema, syncWalletGifts } = require('./services/userWallets');
const adminRoutes = require('./routes/admin.routes');

// Puerto dinámico (Koyeb lo inyecta)
const PORT = env.PORT || 3001;

async function bootstrap() {
  await connectDb();

  try {
    const pool = getPool();
    await Promise.all([
      ensureOrderNumberSchema(pool),
      ensureUserWalletSchema(pool),
      ensureWalletGiftSchema(pool),
    ]);
    console.log("[bootstrap] runtime schemas ready");
  } catch (error) {
    console.error("[bootstrap] runtime schema warmup failed", error);
  }

  startOrderExpiryJob();
  if (typeof adminRoutes.startBroadcastRecoveryLoop === "function") {
    adminRoutes.startBroadcastRecoveryLoop();
  }
  setInterval(async () => {
    try {
      await syncWalletGifts(getPool());
    } catch (error) {
      console.error("[wallet-gifts] sync failed", error);
    }
  }, 60 * 1000);

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 API listening on port ${PORT}`);
  });
}

bootstrap().catch((error) => {
  console.error("[bootstrap] failed to start API", error);
  process.exit(1);
});
