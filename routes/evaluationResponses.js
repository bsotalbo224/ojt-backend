const express = require("express");
const router = express.Router();

const ctrl = require("../controllers/evaluationResponsesController");

/* =========================
   LIST ALL RESPONSES
   GET /api/evaluations/responses
========================= */
router.get("/responses", ctrl.getResponses);


/* =========================
   RESPONSE DETAILS
   GET /api/evaluations/responses/:id
========================= */
router.get("/responses/:id", ctrl.getResponseDetails);


module.exports = router;