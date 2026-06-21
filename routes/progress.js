const express = require("express");
const router = express.Router();
const { requireAuth } = require("../middleware/authMiddleware");
const { requireRole } = require("../middleware/roleMiddleware");
const progressController = require("../controllers/progressController");

// Student progress (self)
router.get(
  "/me",
  requireAuth,
  progressController.getStudentProgress
);

// Admin / Coordinator: view a specific student's progress
router.get(
  "/:student_id",
  requireAuth,
  requireRole("admin", "coordinator"),
  progressController.getStudentProgressById
);

module.exports = router;