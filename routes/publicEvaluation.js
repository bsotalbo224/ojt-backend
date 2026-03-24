const express = require("express");
const router = express.Router();
const ctrl = require("../controllers/publicEvaluationController");

// load evaluation form
router.get("/template/:id", ctrl.getPublicTemplate);

// submit evaluation
router.post("/submit", ctrl.submitEvaluation);

module.exports = router;