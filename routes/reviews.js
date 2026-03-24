const express = require("express");
const router = express.Router();
const db = require("../config/db");
const { requireAuth, requireRole } = require("../middleware/authMiddleware");

/* =========================
   GET STUDENT REVIEWS
========================= */
router.get("/student", requireAuth, requireRole("student"), async (req, res) => {
  try {
    const student_id = req.user.student_id;

    // Daily Logs with feedback
    const [logs] = await db.query(
      `
      SELECT
        log_id AS id,
        'daily_log' AS type,
        log_date AS date,
        status,
        feedback AS comments,
        created_at
      FROM daily_logs
      WHERE student_id = ?
        AND feedback IS NOT NULL
      `,
      [student_id]
    );

    // Narrative Reports with remarks
    const [reports] = await db.query(
      `
      SELECT
        narrative_id AS id,
        'narrative' AS type,
        created_at AS date,
        status,
        coordinator_remarks AS comments,
        created_at
      FROM narrative_reports
      WHERE student_id = ?
        AND coordinator_remarks IS NOT NULL
      `,
      [student_id]
    );

    const combined = [...logs, ...reports].sort(
      (a, b) => new Date(b.date) - new Date(a.date)
    );

    res.json({ success: true, reviews: combined });

  } catch (err) {
    console.error("Fetch reviews error:", err);
    res.status(500).json({ success: false });
  }
});

module.exports = router;
