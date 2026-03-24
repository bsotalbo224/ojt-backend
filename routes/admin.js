const express = require("express");
const router = express.Router();

const AdminModel = require("../models/AdminModel");
const { requireAuth } = require("../middleware/authMiddleware");
const { requireRole } = require("../middleware/roleMiddleware");

router.use(requireAuth);
router.use(requireRole("admin"));

/* ===================================================
ADMIN DASHBOARD STATS
=================================================== */
router.get("/stats", async (req, res) => {
  try {
    const stats = await AdminModel.getStats();
    res.json(stats);
  } catch (err) {
    console.error("ADMIN STATS ERROR:", err);
    res.status(500).json({ message: "Server error" });
  }
});

/* ===================================================
STUDENTS OVERVIEW
=================================================== */
router.get("/students", async (req, res) => {
  try {
    const data = await AdminModel.getStudentsOverview();
    res.json(data);
  } catch (err) {
    console.error("ADMIN STUDENTS ERROR:", err);
    res.status(500).json({ message: "Server error" });
  }
});

/* ===================================================
COORDINATORS LIST
=================================================== */
router.get("/coordinators", async (req, res) => {
  try {
    const data = await AdminModel.getCoordinators();
    res.json(data);
  } catch (err) {
    console.error("ADMIN COORDINATORS ERROR:", err);
    res.status(500).json({ message: "Server error" });
  }
});

router.get("/recent-activity", async (req, res) => {
  try {
    const activities = await AdminModel.getRecentActivity();
    res.json(activities);
  } catch (error) {
    console.error("Recent activity error:", error);
    res.status(500).json({ message: "Failed to load activity" });
  }
});

router.get("/archived-students", async (req, res) => {
  try {
    const students = await AdminModel.getArchivedStudents();

    res.json(students);
  } catch (err) {
    console.error("Failed to fetch archived students:", err);
    res.status(500).json({
      success: false,
      message: "Failed to load archived students",
    });
  }
});

router.post("/restore-student/:id", async (req, res) => {
  try {
    await AdminModel.restoreStudent(req.params.id);

    res.json({
      success: true,
      message: "Student restored successfully",
    });
  } catch (err) {
    console.error(err);

    res.status(500).json({
      success: false,
      message: "Failed to restore student",
    });
  }
});

module.exports = router;
