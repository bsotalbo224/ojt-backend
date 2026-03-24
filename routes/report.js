const express = require("express");
const router = express.Router();

const ReportModel = require("../models/ReportModel");
const { requireAuth } = require("../middleware/authMiddleware");
const { requireRole } = require("../middleware/roleMiddleware");

router.use(requireAuth);

/* ===================================================
STUDENT: MY REPORTS
=================================================== */
router.get("/student", requireRole("student"), async (req, res) => {
  try {
    const studentId = req.user.student_id;
    const data = await ReportModel.getByStudent(studentId);
    res.json(data);
  } catch (err) {
    console.error("STUDENT REPORT ERROR:", err);
    res.status(500).json({ message: "Server error" });
  }
});

/* ===================================================
COORDINATOR: DEPARTMENT REPORTS
=================================================== */
router.get("/coordinator", requireRole("coordinator"), async (req, res) => {
  try {
    const deptId = req.user.department_id;
    const data = await ReportModel.getByDepartment(deptId);
    res.json(data);
  } catch (err) {
    console.error("COORD REPORT ERROR:", err);
    res.status(500).json({ message: "Server error" });
  }
});

/* ===================================================
ADMIN: ALL REPORTS
=================================================== */
router.get("/admin", requireRole("admin"), async (req, res) => {
  try {
    const data = await ReportModel.getByDepartment(null);
    res.json(data);
  } catch (err) {
    console.error("ADMIN REPORT ERROR:", err);
    res.status(500).json({ message: "Server error" });
  }
});

/* ===================================================
STUDENT: CREATE REPORT
=================================================== */
router.post("/", requireRole("student"), async (req, res) => {
  try {
    const studentId = req.user.student_id;
    const { title, content } = req.body;

    const id = await ReportModel.create({
      student_id: studentId,
      title,
      content
    });

    res.json({ report_id: id });
  } catch (err) {
    console.error("CREATE REPORT ERROR:", err);
    res.status(500).json({ message: "Server error" });
  }
});

/* ===================================================
COORDINATOR: REVIEW REPORT
=================================================== */
router.patch("/:id/review", requireRole("coordinator"), async (req, res) => {
  try {
    const id = req.params.id;
    const { status, remarks } = req.body;

    await ReportModel.updateStatus(id, status, remarks);

    res.json({ success: true });
  } catch (err) {
    console.error("REVIEW REPORT ERROR:", err);
    res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
