const express = require("express");
const router = express.Router();
const db = require("../config/db");
const NarrativeModel = require("../models/NarrativeModel");
const { requireAuth } = require("../middleware/authMiddleware");
const { requireRole } = require("../middleware/roleMiddleware");
const upload = require("../middleware/uploadMiddleware");

// protect all routes
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

    if (!rows.length) {
      return res.json([]);
    }

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
STUDENT: CREATE OR UPDATE DAILY NARRATIVE
=================================================== */
router.post(
  "/student",
  requireRole("student"),
  upload.array("attachments"),
  async (req, res) => {

    console.log("BODY:", req.body);
    console.log("FILES:", req.files);
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

      const hasContent = content && content.replace(/<[^>]*>/g, "").trim() !== "";
      const hasAttachments = req.files && req.files.length > 0;

      if (!hasContent && !hasAttachments) {
        return res.status(400).json({
          message: "Please provide a narrative or at least one attachment."
        });
      }

      const id = await NarrativeModel.create({
        narrative_id,
        student_id: studentId,
        narrative_date,
        content,
        status: status || "draft"
      });

      const files = req.files || [];

      for (const file of files) {
        await db.query(`
    INSERT INTO attachments
    (narrative_id, file_name, file_path, file_type)
    VALUES (?, ?, ?, ?)
  `, [
          id,
          file.originalname,
          file.path,
          file.mimetype
        ]);
      }

      res.json({ narrative_id: id });

    } catch (err) {
      console.error("CREATE NARRATIVE ERROR:", err);
      res.status(500).json({ message: "Server error" });
    }
  });


/* ===================================================
GET NARRATIVE ATTACHMENTS
=================================================== */
router.get("/:id/attachments", async (req, res) => {
  try {

    const narrativeId = req.params.id;

    const files = await NarrativeModel.getAttachments(narrativeId);

    res.json(files);

  } catch (err) {
    console.error("GET NARRATIVE ATTACHMENTS ERROR:", err);
    res.status(500).json({ message: "Server error" });
  }
});


/* ===================================================
COORDINATOR: REVIEW NARRATIVE
=================================================== */
router.put("/review/:id", requireRole("coordinator"), async (req, res) => {
  try {

    const id = req.params.id;
    const { status, remarks } = req.body;

    await NarrativeModel.updateStatus(id, status, remarks);

    res.json({ success: true });

  } catch (err) {
    console.error("REVIEW NARRATIVE ERROR:", err);
    res.status(500).json({ message: "Server error" });
  }
});


/* ===================================================
GET SINGLE NARRATIVE
Used by NarrativeComposer when clicking notification
=================================================== */
router.get("/:id", async (req, res) => {
  try {

    const narrativeId = req.params.id;

    const narrative = await NarrativeModel.getById(narrativeId);

    if (!narrative) {
      return res.status(404).json({ message: "Narrative not found" });
    }

    res.json(narrative);

  } catch (err) {
    console.error("GET SINGLE NARRATIVE ERROR:", err);
    res.status(500).json({ message: "Server error" });
  }
});


module.exports = router;
