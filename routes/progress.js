const express = require("express");
const router = express.Router();
const { requireAuth } = require("../middleware/authMiddleware");
const progressController = require("../controllers/progressController");

// Student progress (self)
router.get("/me", requireAuth, progressController.getStudentProgress);

// Optional: admin/coordinator view specific student
router.get("/:student_id", requireAuth, progressController.getStudentProgress);

module.exports = router;