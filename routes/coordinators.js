const express = require("express");
const router = express.Router();
const CoordinatorModel = require("../models/CoordinatorModel");

const { requireAuth } = require("../middleware/authMiddleware");
const { requireRole } = require("../middleware/roleMiddleware");

/* =========================
DASHBOARD STATS
========================= */
router.get(
  "/stats",
  requireAuth,
  requireRole("coordinator", "admin"),
  async (req, res) => {
    try {

      const data =
        await CoordinatorModel.getDashboardStats(
          req.user.user_id,
          req.user.academic_year_id
        );

      res.json(data);

    } catch (err) {

      console.error("COORD STATS ERROR:", err);

      res.status(500).json({
        message: "Server error"
      });
    }
  }
);

/* =========================
COORDINATOR STUDENTS
========================= */
router.get(
  "/students",
  requireAuth,
  requireRole("coordinator", "admin"),
  async (req, res) => {
    try {

      const data =
        await CoordinatorModel.getStudents(
          req.user.user_id,
          req.user.academic_year_id
        );

      res.json(data);

    } catch (err) {

      console.error("COORD STUDENTS ERROR:", err);

      res.status(500).json({
        message: "Server error"
      });
    }
  }
);

/* =========================
STUDENT PROGRESS
GET /api/coordinators/student-progress/:id
========================= */
router.get(
  "/student-progress/:id",
  requireAuth,
  requireRole("coordinator", "admin"),
  async (req, res) => {
    try {

      const data =
        await CoordinatorModel.getStudentProgress(
          req.params.id,
          req.user.academic_year_id,
          req.user.user_id
        );

      res.json(data);

    } catch (err) {

      console.error("COORD PROGRESS ERROR:", err);

      res.status(500).json({
        message: "Server error"
      });
    }
  }
);

/* =========================
ASSIGN COMPANY (coordinator)
PUT /api/coordinators/students/:id/assign-company
========================= */
router.put(
  "/students/:id/assign-company",
  requireAuth,
  requireRole("coordinator", "admin"),
  async (req, res) => {
    try {

      const {
        company_id,
        start_time,
        end_time
      } = req.body;

      const TIME_FORMAT = /^([01]?\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

      const isValidCompanyId =
        company_id !== null &&
        company_id !== undefined &&
        company_id !== "" &&
        !Number.isNaN(Number(company_id));

      const isValidStartTime =
        typeof start_time === "string" && TIME_FORMAT.test(start_time);

      const isValidEndTime =
        typeof end_time === "string" && TIME_FORMAT.test(end_time);

      if (!isValidCompanyId || !isValidStartTime || !isValidEndTime) {
        return res.status(400).json({
          message: "Invalid company_id, start_time, or end_time"
        });
      }

      await CoordinatorModel.assignCompany(
        req.params.id,
        company_id,
        start_time,
        end_time,
        req.user.academic_year_id
      );

      res.json({
        success: true
      });

    } catch (err) {

      console.error("ASSIGN COMPANY ERROR:", err);

      if (err.message.includes("Unauthorized")) {
        return res.status(403).json({
          message: err.message
        });
      }

      if (err.message.includes("not found")) {
        return res.status(404).json({
          message: err.message
        });
      }

      res.status(500).json({
        message: err.message
      });
    }
  }
);

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

      const data =
        await CoordinatorModel.getAll();

      res.json(data);

    } catch (err) {

      console.error(
        "GET COORDINATORS ERROR:",
        err
      );

      res.status(500).json({
        message: "Server error"
      });
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

      const id =
        await CoordinatorModel.create(
          req.body
        );

      res.status(201).json({
        coordinator_id: id
      });

    } catch (err) {

      console.error(
        "CREATE COORDINATOR ERROR:",
        err
      );

      res.status(500).json({
        message: "Server error"
      });
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

      const updated =
        await CoordinatorModel.update(
          req.params.id,
          req.body
        );

      res.json(updated);

    } catch (err) {

      console.error(
        "UPDATE COORDINATOR ERROR:",
        err
      );

      res.status(500).json({
        message: "Server error"
      });
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

      const updated =
        await CoordinatorModel.setStatus(
          req.params.id,
          req.body.is_active
        );

      res.json(updated);

    } catch (err) {

      console.error(
        "STATUS COORDINATOR ERROR:",
        err
      );

      res.status(500).json({
        message: "Server error"
      });
    }
  }
);

module.exports = router;