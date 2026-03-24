const express = require("express");
const router = express.Router();
const CoordinatorModel = require("../models/CoordinatorModel");
const StudentModel = require("../models/StudentModel");

const { requireAuth } = require("../middleware/authMiddleware");
const { requireRole } = require("../middleware/roleMiddleware");

/* =========================
DASHBOARD STATS
========================= */
router.get("/stats", async (req, res) => {
  try {
    const data = await CoordinatorModel.getDashboardStats(req.user.user_id);
    res.json(data);
  } catch (err) {
    console.error("COORD STATS ERROR:", err);
    res.status(500).json({ message: "Server error" });
  }
});


/* =========================
COORDINATOR STUDENTS
========================= */

router.get("/students", async (req, res) => {
  try {
    const data = await CoordinatorModel.getStudents(req.user.user_id);
    res.json(data);
  } catch (err) {
    console.error("COORD STUDENTS ERROR:", err);
    res.status(500).json({ message: "Server error" });
  }
});

/* =========================
STUDENT PROGRESS
GET /api/coordinators/student-progress/:id
========================= */
router.get("/student-progress/:id", async (req, res) => {
  try {
    const data = await CoordinatorModel.getStudentProgress(
      req.params.id
    );
    res.json(data);
  } catch (err) {
    console.error("COORD PROGRESS ERROR:", err);
    res.status(500).json({ message: "Server error" });
  }
});

/* =========================
ASSIGN COMPANY (coordinator)
PUT /api/coordinators/students/:id/assign-company
========================= */
router.put("/students/:id/assign-company", async (req, res) => {
  try {
    const { company_id } = req.body;

    await CoordinatorModel.assignCompany(
      req.params.id,
      company_id
    );

    res.json({ success: true });
  } catch (err) {
    console.error("ASSIGN COMPANY ERROR:", err);
    res.status(500).json({ message: "Server error" });
  }
});

/* =======================
GET ALL COORDINATORS (ADMIN)
GET /api/admin/coordinators
======================= */
router.get(
  "/",
  requireAuth,
  requireRole("admin"),
  async (req, res) => {
    try {
      const data = await CoordinatorModel.getAll();
      res.json(data);
    } catch (err) {
      console.error("GET COORDINATORS ERROR:", err);
      res.status(500).json({ message: "Server error" });
    }
  }
);

/* =======================
CREATE (ADMIN)
POST /api/admin/coordinators
======================= */
router.post(
  "/",
  requireAuth,
  requireRole("admin"),
  async (req, res) => {
    try {
      const id = await CoordinatorModel.create(req.body);
      res.status(201).json({ coordinator_id: id });
    } catch (err) {
      console.error("CREATE COORDINATOR ERROR:", err);
      res.status(500).json({ message: "Server error" });
    }
  }
);

/* =======================
UPDATE (ADMIN)
PUT /api/admin/coordinators/:id
======================= */
router.put(
  "/:id",
  requireAuth,
  requireRole("admin"),
  async (req, res) => {
    try {
      const updated = await CoordinatorModel.update(
        req.params.id,
        req.body
      );
      res.json(updated);
    } catch (err) {
      console.error("UPDATE COORDINATOR ERROR:", err);
      res.status(500).json({ message: "Server error" });
    }
  }
);

/* =======================
TOGGLE STATUS (ADMIN)
PATCH /api/admin/coordinators/:id/status
======================= */
router.patch(
  "/:id/status",
  requireAuth,
  requireRole("admin"),
  async (req, res) => {
    try {
      const updated = await CoordinatorModel.setStatus(
        req.params.id,
        req.body.is_active
      );
      res.json(updated);
    } catch (err) {
      console.error("STATUS COORDINATOR ERROR:", err);
      res.status(500).json({ message: "Server error" });
    }
  }
);

module.exports = router;
