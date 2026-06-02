const express = require("express");
const { listProducts } = require("./products.controller");

const router = express.Router();

router.get("/", listProducts);

module.exports = router;
