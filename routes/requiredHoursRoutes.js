const express = require("express");
const router = express.Router();

const RequiredHoursController = require("../controllers/RequiredHoursController");

const { verifyToken } = require("../middleware/authMiddleware");
const { requireRole } = require("../middleware/roleMiddleware");

// =========================
// GET ALL (Admin + Coordinator)
// =========================
router.get(
  "/",
  verifyToken,
  requireRole("admin", "coordinator"),
  RequiredHoursController.getAll
);

// =========================
// ADD (Admin + Coordinator)
// =========================
router.post(
  "/",
  verifyToken,
  requireRole("admin", "coordinator"),
  RequiredHoursController.create
);

// =========================
// DELETE (Admin ONLY)
// =========================
router.delete(
  "/:id",
  verifyToken,
  requireRole("admin"),
  RequiredHoursController.delete
);

module.exports = router;