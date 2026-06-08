const express = require("express");
const router = express.Router();

const LogModel = require("../models/LogModel");
const { requireAuth } = require("../middleware/authMiddleware");
const { requireRole } = require("../middleware/roleMiddleware");
const upload = require("../middleware/uploadMiddleware");

// Protect all routes
router.use(requireAuth);

/* ===================================================
SECURE ATTACHMENT ACCESS
=================================================== */
router.get("/attachments/:id", async (req, res) => {
  try {
    const attachmentId = req.params.id;
    const user = req.user;

    const file = await LogModel.getAttachmentById(
      attachmentId,
      req.user.academic_year_id
    );

    if (!file) {
      return res.status(404).json({
        message: "File not found"
      });
    }

    // Student access
    if (
      user.role === "student" &&
      user.student_id !== file.student_id
    ) {
      return res.status(403).json({
        message: "Forbidden"
      });
    }

    // Coordinator access
    if (
      user.role === "coordinator" &&
      user.department_id !== file.department_id
    ) {
      return res.status(403).json({
        message: "Forbidden"
      });
    }

    return res.redirect(file.file_path);

  } catch (err) {
    console.error("ATTACHMENT ACCESS ERROR:", err);

    res.status(500).json({
      message: "Server error"
    });
  }
});

/* ===================================================
STUDENT: GET MY LOGS
=================================================== */
router.get("/", requireRole("student"), async (req, res) => {
  try {

    const logs = await LogModel.getByStudent(
      req.user.student_id,
      req.user.academic_year_id
    );

    res.json({
      success: true,
      logs
    });

  } catch (err) {

    console.error("STUDENT LOGS ERROR:", err);

    res.status(500).json({
      success: false,
      message: "Server error"
    });
  }
});

/* ===================================================
STUDENT: CREATE LOG
=================================================== */
router.post("/", requireRole("student"), async (req, res) => {
  try {

    const { log_date, narrative } = req.body;

    if (!log_date || !narrative) {
      return res.status(400).json({
        success: false,
        message: "Date and narrative are required."
      });
    }

    const id = await LogModel.create({
      student_id: req.user.student_id,
      academic_year_id: req.user.academic_year_id,
      log_date,
      narrative
    });

    res.json({
      success: true,
      log_id: id
    });

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

    const { narrative } = req.body;

    if (!narrative) {
      return res.status(400).json({
        success: false,
        message: "Narrative is required."
      });
    }

    const affected = await LogModel.updateByStudent(
      req.params.id,
      req.user.student_id,
      req.user.academic_year_id,
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
  upload.array("files", 5),
  async (req, res) => {
    try {

      const files = req.files;

      if (!files || files.length === 0) {
        return res.status(400).json({
          success: false,
          message: "No files uploaded"
        });
      }

      for (const file of files) {

        await LogModel.addAttachment({
          log_id: req.params.id,
          file_name: file.originalname,
          file_path: file.path,
          file_type: file.mimetype
        });

      }

      res.json({
        success: true,
        message: "Attachments uploaded successfully"
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
router.get(
  "/coordinator",
  requireRole("coordinator"),
  async (req, res) => {
    try {

      const logs = await LogModel.getByDepartment(
        req.user.department_id,
        req.user.academic_year_id
      );

      res.json(logs);

    } catch (err) {

      console.error("COORDINATOR LOGS ERROR:", err);

      res.status(500).json({
        message: "Server error"
      });
    }
  }
);

/* ===================================================
ADMIN: ALL LOGS
=================================================== */
router.get(
  "/admin",
  requireRole("admin"),
  async (req, res) => {
    try {

      const logs = await LogModel.getByDepartment(
        null,
        req.user.academic_year_id
      );

      res.json(logs);

    } catch (err) {

      console.error("ADMIN LOGS ERROR:", err);

      res.status(500).json({
        message: "Server error"
      });
    }
  }
);

/* ===================================================
GET SINGLE LOG
=================================================== */
router.get("/:id", async (req, res) => {
  try {

    const log = await LogModel.getById(
      req.params.id,
      req.user.academic_year_id
    );

    if (!log) {
      return res.status(404).json({
        message: "Log not found"
      });
    }

    if (
      req.user.role === "student" &&
      log.student_id !== req.user.student_id
    ) {
      return res.status(403).json({
        message: "Forbidden"
      });
    }

    if (
      req.user.role === "coordinator" &&
      req.user.department_id !== log.department_id
    ) {
      return res.status(403).json({
        message: "Forbidden"
      });
    }

    res.json(log);

  } catch (err) {

    console.error("GET LOG ERROR:", err);

    res.status(500).json({
      message: "Server error"
    });
  }
});

/* ===================================================
COORDINATOR: REVIEW LOG
=================================================== */
router.patch(
  "/:id/review",
  requireRole("coordinator"),
  async (req, res) => {
    try {

      const { status, remarks } = req.body;

      await LogModel.updateStatus(
        req.params.id,
        status,
        remarks,
        req.user.academic_year_id
      );

      res.json({
        success: true
      });

    } catch (err) {

      console.error("LOG REVIEW ERROR:", err);

      res.status(500).json({
        message: "Server error"
      });
    }
  }
);

/* ===================================================
COORDINATOR: APPROVE LOG
=================================================== */
router.put(
  "/:id/approve",
  requireRole("coordinator"),
  async (req, res) => {
    try {

      await LogModel.updateStatus(
        req.params.id,
        "approved",
        null,
        req.user.academic_year_id
      );

      res.json({
        success: true
      });

    } catch (err) {

      console.error("APPROVE LOG ERROR:", err);

      res.status(500).json({
        message: "Server error"
      });
    }
  }
);

/* ===================================================
COORDINATOR: REVISION
=================================================== */
router.put(
  "/:id/reject",
  requireRole("coordinator"),
  async (req, res) => {
    try {

      const { feedback } = req.body;

      await LogModel.updateStatus(
        req.params.id,
        "revision",
        feedback,
        req.user.academic_year_id
      );

      res.json({
        success: true
      });

    } catch (err) {

      console.error("REJECT LOG ERROR:", err);

      res.status(500).json({
        message: "Server error"
      });
    }
  }
);

module.exports = router;