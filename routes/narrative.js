const express = require("express");
const router = express.Router();
const db = require("../config/db");
const NarrativeModel = require("../models/NarrativeModel");
const { requireAuth } = require("../middleware/authMiddleware");
const { requireRole } = require("../middleware/roleMiddleware");
const upload = require("../middleware/uploadMiddleware");

// Protect all routes
router.use(requireAuth);

/* ===================================================
STUDENT: MY NARRATIVES
=================================================== */
router.get("/student/me", requireRole("student"), async (req, res) => {
  try {
    const studentId = req.user.student_id;
    const data = await NarrativeModel.getByStudent(studentId);
    res.json(data);
  } catch (err) {
    console.error("STUDENT NARRATIVE ERROR:", err);
    res.status(500).json({ message: "Server error" });
  }
});

/* ===================================================
COORDINATOR: DEPARTMENT NARRATIVES
=================================================== */
router.get("/coordinator", requireRole("coordinator"), async (req, res) => {
  try {
    const coordId = req.user.coordinator_id;

    const [rows] = await db.query(
      "SELECT department_id FROM coordinators WHERE coordinator_id = ?",
      [coordId]
    );

    if (!rows.length) return res.json([]);

    const deptId = rows[0].department_id;
    const data = await NarrativeModel.getByDepartment(deptId);

    res.json(data);
  } catch (err) {
    console.error("COORD NARRATIVE ERROR:", err);
    res.status(500).json({ message: "Server error" });
  }
});

/* ===================================================
ADMIN: ALL NARRATIVES
=================================================== */
router.get("/admin", requireRole("admin"), async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT 
        n.*,
        CONCAT(u.f_name,' ',u.l_name) AS student_name,
        comp.company_name,
        cr.course_code
      FROM narrative_reports n
      JOIN students s ON n.student_id = s.student_id
      JOIN users u ON s.user_id = u.user_id
      LEFT JOIN courses cr ON s.course_id = cr.course_id
      LEFT JOIN companies comp ON s.company_id = comp.company_id
      ORDER BY n.narrative_date DESC
    `);

    res.json(rows);
  } catch (err) {
    console.error("ADMIN NARRATIVE ERROR:", err);
    res.status(500).json({ message: "Server error" });
  }
});

/* ===================================================
STUDENT: CREATE / UPDATE NARRATIVE
=================================================== */
router.post(
  "/student",
  requireRole("student"),
  upload.array("attachments"),
  async (req, res) => {
    try {
      const studentId = req.user.student_id;

      const {
        narrative_id,
        narrative_date,
        content,
        status
      } = req.body;

      if (!narrative_date) {
        return res.status(400).json({ message: "Narrative date is required." });
      }

      // Validate content or attachments
      const hasContent =
        content && content.replace(/<[^>]*>/g, "").trim() !== "";
      const hasAttachments = req.files && req.files.length > 0;

      if (!hasContent && !hasAttachments) {
        return res.status(400).json({
          message: "Provide narrative content or at least one attachment."
        });
      }

      // 🔐 Ownership check (important)
      if (narrative_id) {
        const [[existing]] = await db.query(
          "SELECT student_id FROM narrative_reports WHERE narrative_id = ?",
          [narrative_id]
        );

        if (!existing || existing.student_id !== studentId) {
          return res.status(403).json({ message: "Unauthorized" });
        }
      }

      // Create or update narrative
      const id = await NarrativeModel.create({
        narrative_id,
        student_id: studentId,
        narrative_date,
        content,
        status: status || "draft"
      });

      const files = req.files || [];

      // Optional: clear old attachments on update
      if (narrative_id && files.length > 0) {
        await db.query(
          "DELETE FROM attachments WHERE narrative_id = ?",
          [narrative_id]
        );
      }

      // Save attachments (Cloudinary URLs)
      for (const file of files) {
        await db.query(`
          INSERT INTO attachments
          (narrative_id, log_id, file_name, file_path, file_type)
          VALUES (?, NULL, ?, ?, ?)
        `, [
          id,
          file.originalname,
          file.path,     // ✅ Cloudinary URL
          file.mimetype
        ]);
      }

      res.json({
        success: true,
        narrative_id: id,
        attachments: files.map(file => ({
          name: file.originalname,
          url: file.path
        }))
      });

    } catch (err) {
      console.error("CREATE NARRATIVE ERROR:", err);
      res.status(500).json({
        message: err.message || "Server error"
      });
    }
  }
);

/* ===================================================
GET NARRATIVE ATTACHMENTS
=================================================== */
router.get("/:id/attachments", async (req, res) => {
  try {
    const files = await NarrativeModel.getAttachments(req.params.id);
    res.json(files);
  } catch (err) {
    console.error("GET ATTACHMENTS ERROR:", err);
    res.status(500).json({ message: "Server error" });
  }
});

/* ===================================================
SECURE FILE ACCESS (Cloudinary redirect)
=================================================== */
router.get("/attachments/file/:id", async (req, res) => {
  try {
    const [[file]] = await db.query(
      "SELECT * FROM attachments WHERE attachment_id = ?",
      [req.params.id]
    );

    if (!file) {
      return res.status(404).json({ message: "File not found" });
    }

    return res.redirect(file.file_path); // ✅ Cloudinary
  } catch (err) {
    console.error("FILE ACCESS ERROR:", err);
    res.status(500).json({ message: "Server error" });
  }
});

/* ===================================================
COORDINATOR: REVIEW
=================================================== */
router.put("/review/:id", requireRole("coordinator"), async (req, res) => {
  try {
    const { status, remarks } = req.body;
    await NarrativeModel.updateStatus(req.params.id, status, remarks);
    res.json({ success: true });
  } catch (err) {
    console.error("REVIEW ERROR:", err);
    res.status(500).json({ message: "Server error" });
  }
});

/* ===================================================
GET SINGLE NARRATIVE
=================================================== */
router.get("/:id", async (req, res) => {
  try {
    const narrative = await NarrativeModel.getById(req.params.id);

    if (!narrative) {
      return res.status(404).json({ message: "Narrative not found" });
    }

    res.json(narrative);
  } catch (err) {
    console.error("GET NARRATIVE ERROR:", err);
    res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;