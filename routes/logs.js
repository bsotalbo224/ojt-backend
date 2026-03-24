const express = require("express");
const router = express.Router();

const LogModel = require("../models/LogModel");
const { requireAuth } = require("../middleware/authMiddleware");
const { requireRole } = require("../middleware/roleMiddleware");
const upload = require("../middleware/uploadMiddleware");
const path = require("path");

// Protect all routes
router.use(requireAuth);

/* ===================================================
SECURE ATTACHMENT ACCESS
=================================================== */
router.get("/attachments/:id", async (req, res) => {
  try {
    const attachmentId = req.params.id;
    const user = req.user;

    const file = await LogModel.getAttachmentById(attachmentId);

    if (!file) {
      return res.status(404).json({ message: "File not found" });
    }

    if (user.role === "student" && user.student_id !== file.student_id) {
      return res.status(403).json({ message: "Forbidden" });
    }

    if (user.role === "coordinator" && user.department_id !== file.department_id) {
      return res.status(403).json({ message: "Forbidden" });
    }

    const fs = require("fs");
    const filePath = path.join(__dirname, "..", "uploads", file.file_path);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ message: "File missing on server" });
    }

    res.sendFile(filePath);

  } catch (err) {
    console.error("ATTACHMENT ACCESS ERROR:", err);
    res.status(500).json({ message: "Server error" });
  }
});

/* ===================================================
STUDENT: GET MY LOGS
=================================================== */
router.get("/", requireRole("student"), async (req, res) => {
  try {
    const studentId = req.user.student_id;
    const logs = await LogModel.getByStudent(studentId);

    res.json({ success: true, logs });

  } catch (err) {
    console.error("STUDENT LOGS ERROR:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

/* ===================================================
STUDENT: CREATE LOG
=================================================== */
router.post("/", requireRole("student"), async (req, res) => {
  try {
    const studentId = req.user.student_id;
    const { log_date, narrative } = req.body;

    if (!log_date || !narrative) {
      return res.status(400).json({
        success: false,
        message: "Date and narrative are required."
      });
    }

    const id = await LogModel.create({
      student_id: studentId,
      log_date,
      narrative
    });

    res.json({ success: true, log_id: id });

  } catch (err) {
    console.error("CREATE LOG ERROR:", err);
    res.status(400).json({
      success: false,
      message: err.message || "Failed to create log"
    });
  }
});

/* ===================================================
STUDENT: UPDATE / RESUBMIT LOG
=================================================== */
router.put("/:id", requireRole("student"), async (req, res) => {
  try {
    const logId = req.params.id;
    const studentId = req.user.student_id;
    const { narrative } = req.body;

    if (!narrative) {
      return res.status(400).json({
        success: false,
        message: "Narrative is required."
      });
    }

    const affected = await LogModel.updateByStudent(
      logId,
      studentId,
      { narrative }
    );

    if (!affected) {
      return res.status(404).json({
        success: false,
        message: "Log not found or not owned by student"
      });
    }

    res.json({
      success: true,
      message: "Log resubmitted"
    });

  } catch (err) {
    console.error("UPDATE LOG ERROR:", err);
    res.status(500).json({
      success: false,
      message: "Server error"
    });
  }
});

/* ===================================================
STUDENT: UPLOAD ATTACHMENT
=================================================== */
router.post(
  "/:id/attachments",
  requireRole("student"),
  upload.single("file"),
  async (req, res) => {
    try {
      const logId = req.params.id;

      if (!req.file) {
        return res.status(400).json({
          success: false,
          message: "No file uploaded"
        });
      }

      await LogModel.addAttachment({
        log_id: logId,
        file_name: req.file.originalname,
        file_path: `daily_logs/${req.file.filename}`,
        file_type: req.file.mimetype
      });

      res.json({
        success: true,
        message: "Attachment uploaded"
      });

    } catch (err) {
      console.error("ATTACHMENT ERROR:", err);
      res.status(500).json({
        success: false,
        message: "Upload failed"
      });
    }
  }
);

/* ===================================================
COORDINATOR: GET DEPARTMENT LOGS
=================================================== */
router.get("/coordinator", requireRole("coordinator"), async (req, res) => {
  try {
    const deptId = req.user.department_id;
    const logs = await LogModel.getByDepartment(deptId);
    res.json(logs);

  } catch (err) {
    console.error("COORDINATOR LOGS ERROR:", err);
    res.status(500).json({ message: "Server error" });
  }
});

/* ===================================================
ADMIN: ALL LOGS
=================================================== */
router.get("/admin", requireRole("admin"), async (req, res) => {
  try {
    const logs = await LogModel.getByDepartment(null);
    res.json(logs);

  } catch (err) {
    console.error("ADMIN LOGS ERROR:", err);
    res.status(500).json({ message: "Server error" });
  }
});

/* ===================================================
GET SINGLE LOG (role-protected)
=================================================== */
router.get("/:id", async (req, res) => {
  try {
    const logId = req.params.id;
    const user = req.user;

    const log = await LogModel.getById(logId);

    if (!log) {
      return res.status(404).json({ message: "Log not found" });
    }

    if (user.role === "student" && log.student_id !== user.student_id) {
      return res.status(403).json({ message: "Forbidden" });
    }

    if (user.role === "coordinator" && user.department_id !== log.department_id) {
      return res.status(403).json({ message: "Forbidden" });
    }

    res.json(log);

  } catch (err) {
    console.error("GET LOG ERROR:", err);
    res.status(500).json({ message: "Server error" });
  }
});

/* ===================================================
COORDINATOR: REVIEW LOG
=================================================== */
router.patch("/:id/review", requireRole("coordinator"), async (req, res) => {
  try {
    const logId = req.params.id;
    const { status, remarks } = req.body;

    await LogModel.updateStatus(logId, status, remarks);
    res.json({ success: true });

  } catch (err) {
    console.error("LOG REVIEW ERROR:", err);
    res.status(500).json({ message: "Server error" });
  }
});

/* ===================================================
COORDINATOR: APPROVE
=================================================== */
router.put("/:id/approve", requireRole("coordinator"), async (req, res) => {
  try {
    await LogModel.updateStatus(req.params.id, "approved", null);
    res.json({ success: true });

  } catch (err) {
    console.error("APPROVE LOG ERROR:", err);
    res.status(500).json({ message: "Server error" });
  }
});

/* ===================================================
COORDINATOR: REJECT / REVISION
=================================================== */
router.put("/:id/reject", requireRole("coordinator"), async (req, res) => {
  try {
    const { feedback } = req.body;
    await LogModel.updateStatus(req.params.id, "revision", feedback);
    res.json({ success: true });

  } catch (err) {
    console.error("REJECT LOG ERROR:", err);
    res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;