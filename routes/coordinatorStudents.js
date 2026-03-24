const express = require("express");
const router = express.Router();
const db = require("../config/db");
const { requireAuth, requireRole } = require("../middleware/authMiddleware");

/**
 * GET /api/coordinators/students
 * Returns students under the logged-in coordinator's department
 */
router.get(
  "/students",
  requireAuth,
  requireRole("coordinator"),
  async (req, res) => {
    const connection = await db.getConnection();

    try {
      const userId = req.user.user_id;

      // 1️⃣ Get coordinator department
      const [[coordinator]] = await connection.query(
        `
        SELECT department_id
        FROM coordinators
        WHERE user_id = ?
          AND is_active = 1
        `,
        [userId]
      );

      if (!coordinator) {
        return res.status(403).json({
          success: false,
          message: "Coordinator record not found or inactive."
        });
      }

      const departmentId = coordinator.department_id;

      // 2️⃣ Get students in same department
      const [students] = await connection.query(
        `
        SELECT
          s.student_id,
          u.f_name,
          u.l_name,
          c.course_name
        FROM students s
        JOIN users u ON s.user_id = u.user_id
        LEFT JOIN courses c ON s.course_id = c.course_id
        WHERE s.department_id = ?
          AND s.is_active = 1
        ORDER BY u.l_name ASC
        `,
        [departmentId]
      );

      // 3️⃣ Format response
      const formatted = students.map((s) => ({
        id: s.student_id, // IMPORTANT: use student_id
        name: `${s.f_name} ${s.l_name}`,
        course: s.course_name || null
      }));

      return res.json({
        success: true,
        students: formatted
      });

    } catch (error) {
      console.error("Coordinator students error:", error);
      return res.status(500).json({
        success: false,
        message: "Failed to load students."
      });
    } finally {
      connection.release();
    }
  }
);

module.exports = router;