const express = require("express");
const {
  createOrder,
  getOrderById,
  getPaymentMethods,
  payOrderWithWallet,
  submitPaymentProof,
} = require("./orders.controller");

const router = express.Router();

function requireBotSecret(req, res, next) {
  const secret = req.header("x-bot-secret");
  const expectedSecret = process.env.BOT_TO_API_SECRET;
  if (!expectedSecret || secret !== expectedSecret) {
    return res.status(401).json({ error: "UNAUTHORIZED" });
  }
  return next();
}

router.post("/", requireBotSecret, createOrder);
router.get("/payment-methods", getPaymentMethods);
router.get("/:id", requireBotSecret, getOrderById);
router.post("/:id/pay-with-wallet", requireBotSecret, payOrderWithWallet);
router.post("/:id/payment-proof", requireBotSecret, submitPaymentProof);

module.exports = router;
