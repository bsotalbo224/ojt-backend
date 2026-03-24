const express = require("express");
const router = express.Router();
const { requireAuth } = require("../middleware/authMiddleware");
const { requireRole } = require("../middleware/roleMiddleware");
const controller = require("../controllers/adminReportsController");

router.use(requireAuth, requireRole("admin"));

// ===============================
// HOURS SUMMARY
// ===============================
router.get("/hours", controller.getHoursSummary);

// ===============================
// ATTENDANCE SUMMARY
// ===============================
router.get("/attendance", controller.getAttendanceSummary);

// ===============================
// DEPLOYMENT BY COMPANY
// ===============================
router.get("/deployment", controller.getDeploymentSummary);

// ===============================
// EVALUATION SUMMARY
// ===============================
//router.get("/evaluations", controller.getEvaluationSummary);

// ===============================
// DEPARTMENT OVERVIEW
// ===============================
router.get("/companies", controller.getCompanySummary);

module.exports = router;