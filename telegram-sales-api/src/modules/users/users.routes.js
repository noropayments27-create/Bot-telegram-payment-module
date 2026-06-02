const express = require("express");
const {
  upsertTelegramUser,
  getUserByTelegramId,
  getUserWallet,
  getUserWalletHistory,
  createUserWalletTopup,
  getUserWalletTopup,
  submitUserWalletTopupProof,
  claimUserWalletGift,
  updateUserLocale,
  getUserBanStatus,
  banUserFromBot,
  getAffiliateStatus,
  getAffiliateTop,
  applyAffiliate,
  assignAffiliateCode,
  requestAffiliatePayout,
  decideAffiliateStatus,
  decideAffiliateInvoice,
} = require("./users.controller");

const router = express.Router();

function requireBotSecret(req, res, next) {
  const secret = req.header("x-bot-secret");
  const expectedSecret = process.env.BOT_TO_API_SECRET;
  if (!expectedSecret || secret !== expectedSecret) {
    return res.status(401).json({ error: "UNAUTHORIZED" });
  }
  return next();
}

router.get("/affiliates/status", requireBotSecret, getAffiliateStatus);
router.get("/affiliates/top", requireBotSecret, getAffiliateTop);
router.post("/affiliates/apply", requireBotSecret, applyAffiliate);
router.post("/affiliates/code/assign", requireBotSecret, assignAffiliateCode);
router.post("/affiliates/withdraw", requireBotSecret, requestAffiliatePayout);
router.post("/affiliates/invoices/decision", requireBotSecret, decideAffiliateInvoice);
router.post("/affiliates/:id/decision", requireBotSecret, decideAffiliateStatus);
router.get("/:telegram_id/wallet", requireBotSecret, getUserWallet);
router.get("/:telegram_id/wallet/history", requireBotSecret, getUserWalletHistory);
router.post("/:telegram_id/wallet/topups", requireBotSecret, createUserWalletTopup);
router.get("/wallet-topups/:id", requireBotSecret, getUserWalletTopup);
router.post("/wallet-topups/:id/payment-proof", requireBotSecret, submitUserWalletTopupProof);
router.post("/wallet-gifts/claim", requireBotSecret, claimUserWalletGift);
router.post("/:telegram_id/ban", requireBotSecret, banUserFromBot);
router.post("/telegram/upsert", requireBotSecret, upsertTelegramUser);
router.get("/:telegram_id", requireBotSecret, getUserByTelegramId);
router.get("/:telegram_id/ban", requireBotSecret, getUserBanStatus);
router.patch("/:telegram_id/locale", requireBotSecret, updateUserLocale);

module.exports = router;
