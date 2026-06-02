const express = require("express");
const {
  getCart,
  addToCart,
  clearCart,
  checkoutCart,
} = require("./cart.controller");

const router = express.Router();

router.get("/", getCart);
router.post("/add", addToCart);
router.post("/clear", clearCart);
router.post("/checkout", checkoutCart);

module.exports = router;
