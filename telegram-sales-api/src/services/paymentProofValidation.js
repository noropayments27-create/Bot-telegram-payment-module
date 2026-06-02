const { recognize } = require("tesseract.js");
const { getFilePath, downloadFile } = require("./telegram");

const OCR_ENABLED = String(process.env.PAYMENT_PROOF_OCR_ENABLED || "true").toLowerCase() !== "false";
const OCR_STRICT = String(process.env.PAYMENT_PROOF_OCR_STRICT || "false").toLowerCase() === "true";
const OCR_TIMEOUT_MS = Number(process.env.PAYMENT_PROOF_OCR_TIMEOUT_MS || 45000);
const OCR_LANGS = String(process.env.PAYMENT_PROOF_OCR_LANGS || "spa+eng").trim() || "spa+eng";

const PAYMENT_KEYWORDS = [
  "pago",
  "pagado",
  "comprobante",
  "recibo",
  "transferencia",
  "transaccion",
  "transacción",
  "deposito",
  "depósito",
  "payment",
  "paid",
  "receipt",
  "transaction",
  "transfer",
  "transferido",
  "transferida",
  "transferidas",
  "successful",
  "success",
  "approved",
  "aprobado",
  "completado",
  "completada",
  "retiro",
  "withdraw",
  "withdrawal",
  "txid",
  "hash",
  "network",
  "red",
  "billetera",
  "wallet",
];

const METHOD_KEYWORDS = {
  NEQUI: [
    "nequi",
    "bancolombia",
    "cop",
    "envio realizado",
    "envio",
    "detalle del movimiento",
    "numero nequi",
    "referencia",
  ],
  BINANCE_ID: ["binance", "binance id", "pay id", "p2p", "id"],
  MERCADO_PAGO: ["mercado pago", "mercadopago", "clabe", "spei", "mxn"],
  USDT: [
    "usdt",
    "tron",
    "trc20",
    "bsc",
    "bep20",
    "binance smart chain",
    "binance",
    "txid",
    "direccion",
    "dirección",
    "wallet",
    "billetera",
  ],
  BTC: ["btc", "bitcoin"],
  LTC: ["ltc", "litecoin"],
  CRYPTO: ["crypto", "cripto", "usdt", "btc", "ltc", "wallet", "address"],
  PAYPAL: ["paypal"],
};

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function normalizeMethod(paymentMethod) {
  const raw = String(paymentMethod || "").trim().toUpperCase();
  if (!raw) {
    return "";
  }
  if (raw === "MP") {
    return "MERCADO_PAGO";
  }
  if (raw === "MERCADOPAGO") {
    return "MERCADO_PAGO";
  }
  if (raw === "BINANCE") {
    return "BINANCE_ID";
  }
  if (raw === "USDT_TRON" || raw === "USDT_BSC") {
    return "USDT";
  }
  if (["BTC", "LTC", "USDT"].includes(raw)) {
    return raw;
  }
  if (raw === "CRYPTO") {
    return "CRYPTO";
  }
  return raw;
}

function includesAny(text, words) {
  return words.some((word) => text.includes(word));
}

function evaluateProofText(text, paymentMethod) {
  const rawText = String(text || "");
  const normalized = normalizeText(rawText);
  const method = normalizeMethod(paymentMethod);
  const methodKeywords = METHOD_KEYWORDS[method] || [];

  const hasReadableText = normalized.replace(/\s+/g, "").length >= 10;
  const hasPaymentKeyword = includesAny(normalized, PAYMENT_KEYWORDS);
  const hasMethodHint = methodKeywords.length > 0 ? includesAny(normalized, methodKeywords) : false;
  const hasNumericAmount = /\b\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{1,8})?\b/.test(rawText);
  const hasAmountWord = /\b(total|monto|valor|importe|amount|pagaste|pagado|enviar|send)\b/.test(
    normalized
  );
  const hasCurrencyHint = /\b(usd|cop|mxn|usdt|btc|ltc|eur|ars)\b/.test(normalized) || /\$\s*\d/.test(rawText);
  const hasLooseAmountPattern =
    /\b\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{1,2})?\b/.test(rawText) ||
    /\b\d+(?:[.,]\d{1,8})?\s*(usd|cop|mxn|usdt|btc|ltc|eur|ars)\b/i.test(rawText);
  const hasAmountPattern =
    (hasAmountWord && hasNumericAmount) ||
    /\$\s*\d/.test(rawText) ||
    /\b\d+[.,]\d{2}\s*(usd|cop|mxn|usdt|btc|ltc)\b/i.test(rawText) ||
    hasLooseAmountPattern;
  const hasTxidLike =
    /\btxid\b/.test(normalized) ||
    /\b[a-f0-9]{16,}\b/i.test(rawText) ||
    /\b\d{10,}\b/.test(rawText);
  const hasAddressLike = /\b0x[a-f0-9]{16,}\b/i.test(rawText) || /\bdireccion\b|\bdirección\b/.test(normalized);
  const hasTransferState = /\b(completad[oa]|successful|success|approved|aprobad[oa])\b/.test(normalized);
  const hasReferenceLike = /\b(ref|referencia|reference|operacion|operation)\b/.test(normalized);
  const hasDateLike =
    /\b20\d{2}[-/]\d{1,2}[-/]\d{1,2}\b/.test(rawText) ||
    /\b\d{1,2}\s+de\s+[a-z]+\s+de\s+20\d{2}\b/.test(normalized);
  const hasStrongSignal =
    hasPaymentKeyword ||
    hasMethodHint ||
    hasTxidLike ||
    hasAddressLike ||
    hasTransferState ||
    hasReferenceLike ||
    hasDateLike;
  const structuredSignalCount = [
    hasPaymentKeyword,
    hasMethodHint,
    hasTxidLike,
    hasAddressLike,
    hasTransferState,
    hasReferenceLike,
    hasDateLike,
  ].filter(Boolean).length;

  let score = 0;
  if (hasReadableText) score += 1;
  if (hasPaymentKeyword) score += 2;
  if (hasAmountPattern) score += 2;
  if (hasCurrencyHint) score += 1;
  if (hasMethodHint) score += 2;
  if (hasTxidLike) score += 1;
  if (hasAddressLike) score += 1;
  if (hasTransferState) score += 1;
  if (hasReferenceLike) score += 1;
  if (hasDateLike) score += 1;

  const methodCheckPassed =
    methodKeywords.length === 0 ||
    hasMethodHint ||
    hasTxidLike ||
    hasAddressLike ||
    (method === "NEQUI" && /\bnequi\b/.test(normalized)) ||
    ((method === "USDT" || method === "CRYPTO" || method === "BINANCE_ID") &&
      /\b(usdt|trx|trc20|bsc|bep20|binance)\b/.test(normalized));
  const valid =
    hasReadableText &&
    hasAmountPattern &&
    (hasStrongSignal || structuredSignalCount >= 2) &&
    methodCheckPassed &&
    score >= 4;

  let reason = "OK";
  if (!hasReadableText) {
    reason = "NO_READABLE_TEXT";
  } else if (!hasAmountPattern) {
    reason = "NO_AMOUNT_PATTERN";
  } else if (!hasStrongSignal) {
    reason = "NO_PAYMENT_SIGNALS";
  } else if (!methodCheckPassed) {
    reason = "NO_METHOD_HINT";
  }

  return {
    valid,
    reason,
    score,
    structuredSignalCount,
    hasReadableText,
    hasPaymentKeyword,
    hasAmountPattern,
    hasCurrencyHint,
    hasMethodHint,
    hasTxidLike,
    hasAddressLike,
    hasTransferState,
    hasReferenceLike,
    hasDateLike,
    textSample: rawText.slice(0, 200),
  };
}

async function recognizeWithTimeout(imageBuffer, langs) {
  const ocrTask = recognize(imageBuffer, langs, {
    logger: () => {},
  });
  const timeoutTask = new Promise((_, reject) => {
    setTimeout(() => reject(new Error("OCR_TIMEOUT")), OCR_TIMEOUT_MS);
  });
  const result = await Promise.race([ocrTask, timeoutTask]);
  return result?.data?.text || "";
}

async function validatePaymentProofScreenshot(screenshotFileId, paymentMethod) {
  if (!OCR_ENABLED) {
    return { valid: true, skipped: true, reason: "OCR_DISABLED" };
  }
  if (!screenshotFileId) {
    return { valid: false, reason: "MISSING_FILE_ID", score: 0 };
  }
  try {
    const filePath = await getFilePath(screenshotFileId);
    const fileData = await downloadFile(filePath);
    const normalizedContentType = String(fileData?.contentType || "").toLowerCase();
    const fileLooksLikeImage =
      normalizedContentType.startsWith("image/") ||
      /\.(jpe?g|png|webp|bmp|gif|heic|heif)$/i.test(String(filePath || ""));
    if (!fileLooksLikeImage) {
      console.log("payment_proof_validation_non_image_content_type", {
        paymentMethod,
        contentType: normalizedContentType || null,
        filePath,
      });
    }

    let extractedText = "";
    let successfulPasses = 0;
    let bestEvaluation = null;
    const fallbackLangs = [];
    if (OCR_LANGS !== "eng") {
      fallbackLangs.push("eng");
    }
    if (!OCR_LANGS.includes("spa")) {
      fallbackLangs.push("spa");
    }
    const ocrLangs = [OCR_LANGS, ...fallbackLangs];

    for (const langs of ocrLangs) {
      let passText = "";
      try {
        passText = await recognizeWithTimeout(fileData.buffer, langs);
      } catch (error) {
        // continue with other OCR passes
        continue;
      }
      successfulPasses += 1;
      if (String(passText || "").trim()) {
        extractedText = extractedText ? `${extractedText}\n${passText}` : passText;
      }
      const evaluation = evaluateProofText(extractedText || passText, paymentMethod);
      if (!bestEvaluation || evaluation.score > bestEvaluation.score) {
        bestEvaluation = evaluation;
      }
      if (evaluation.valid) {
        bestEvaluation = evaluation;
        break;
      }
      if (String(extractedText || "").trim().length >= 80 && evaluation.score >= 4) {
        // enough text was processed; extra passes rarely add value after this point
        break;
      }
    }
    if (successfulPasses === 0) {
      throw new Error("OCR_ALL_PASSES_FAILED");
    }
    const evaluation = bestEvaluation || evaluateProofText(extractedText, paymentMethod);
    if (!evaluation.valid) {
      console.log("payment_proof_validation_failed", {
        reason: evaluation.reason,
        score: evaluation.score,
        paymentMethod,
        signals: {
          hasReadableText: evaluation.hasReadableText,
          hasPaymentKeyword: evaluation.hasPaymentKeyword,
          hasAmountPattern: evaluation.hasAmountPattern,
          hasCurrencyHint: evaluation.hasCurrencyHint,
          hasMethodHint: evaluation.hasMethodHint,
          hasTxidLike: evaluation.hasTxidLike,
          hasAddressLike: evaluation.hasAddressLike,
          hasTransferState: evaluation.hasTransferState,
          hasReferenceLike: evaluation.hasReferenceLike,
          hasDateLike: evaluation.hasDateLike,
          structuredSignalCount: evaluation.structuredSignalCount,
        },
        textSample: evaluation.textSample,
      });
    }
    return evaluation;
  } catch (error) {
    console.error("Payment proof OCR check failed; skipping strict validation", error);
    if (OCR_STRICT) {
      return { valid: false, reason: "OCR_ERROR", score: 0 };
    }
    return { valid: true, skipped: true, reason: "OCR_ERROR" };
  }
}

module.exports = {
  validatePaymentProofScreenshot,
  evaluateProofText,
};
