const express = require("express");
const router = express.Router();

const AttendanceModel = require("../models/AttendanceModel");

const { requireAuth } = require("../middleware/authMiddleware");
const { requireRole } = require("../middleware/roleMiddleware");
const upload = require("../middleware/uploadMiddleware");

router.use(requireAuth);

/* ===================================================
BUSINESS ERROR MESSAGES (expected, return 400 not 500)
=================================================== */
const BUSINESS_ERRORS = [
  "No active attendance",
  "Already timed in",
  "Already timed out",
  "Lunch break not started",
  "Lunch break already started",
  "Lunch break already ended",
  "OT already started",
  "Attendance already completed"
];

/* ===================================================
STUDENT: MY ATTENDANCE (TODAY)
=================================================== */
router.get("/student", requireRole("student"), async (req, res) => {
  try {

    const studentId = req.user.student_id;

    const data = await AttendanceModel.getToday(studentId, req.user.academic_year_id);

    res.json(data);

  } catch (err) {

    console.error("STUDENT ATTENDANCE ERROR:", err);

    res.status(500).json({
      message: "Server error"
    });
  }
});

/* ===================================================
COORDINATOR: DEPARTMENT ATTENDANCE
=================================================== */
router.get("/coordinator", requireRole("coordinator"), async (req, res) => {
  try {

    const deptId = req.user.department_id;

    const data = await AttendanceModel.getByDepartment(deptId, req.user.academic_year_id);

    res.json(data);

  } catch (err) {

    console.error("COORD ATTENDANCE ERROR:", err);

    res.status(500).json({
      message: "Server error"
    });
  }
});

/* ===================================================
COORDINATOR: STUDENT ATTENDANCE RECORDS
=================================================== */
router.get(
  "/student/:studentId",
  requireRole("coordinator"),
  async (req, res) => {

    try {

      const { studentId } = req.params;

      const data =
        await AttendanceModel.getStudentAttendanceRecords(
          studentId,
          req.user.academic_year_id
        );

      res.json(data);

    } catch (err) {

      console.error(
        "STUDENT ATTENDANCE RECORDS ERROR:",
        err
      );

      res.status(500).json({
        message: "Server error"
      });
    }
  }
);

/* ===================================================
ADMIN: ALL ATTENDANCE
=================================================== */
router.get("/admin", requireRole("admin"), async (req, res) => {
  try {

    const data = await AttendanceModel.getByDepartment(null, req.user.academic_year_id);

    res.json(data);

  } catch (err) {

    console.error("ADMIN ATTENDANCE ERROR:", err);

    res.status(500).json({
      message: "Server error"
    });
  }
});

/* ===================================================
STUDENT: TIME IN / START OT
=================================================== */
router.post(
  "/timein",
  requireRole("student"),
  upload.single("early_attachment"),
  async (req, res) => {
    try {

      const studentId = req.user.student_id;

      const {
        latitude,
        longitude,
        early_reason
      } = req.body;

      const file = req.file;

      const id = await AttendanceModel.timeIn({
        student_id: studentId,
        academic_year_id: req.user.academic_year_id,
        latitude,
        longitude,
        early_reason,
        early_attachment_url: file?.path || null,
        early_attachment_public_id: file?.filename || null,
        early_attachment_name: file?.originalname || null
      });

      res.json({
        success: true,
        attendance_id: id
      });

    } catch (err) {

      console.error("TIMEIN ERROR:", err);

      if (
        err.message === "Reason is required for early attendance." ||
        err.message === "Attachment is required for early attendance."
      ) {
        return res.status(400).json({
          message: err.message
        });
      }

      res.status(500).json({
        message: err.message || "Server error"
      });
    }
  }
);

/* ===================================================
STUDENT: START LUNCH BREAK
=================================================== */
router.patch("/lunch/start", requireRole("student"), async (req, res) => {
  try {

    const studentId = req.user.student_id;

    await AttendanceModel.startLunchBreak(studentId, req.user.academic_year_id);

    res.json({
      success: true
    });

  } catch (err) {

    console.error("LUNCH START ERROR:", err);

    if (BUSINESS_ERRORS.includes(err.message)) {
      return res.status(400).json({
        message: err.message
      });
    }

    res.status(500).json({
      message: err.message || "Server error"
    });
  }
});

/* ===================================================
STUDENT: END LUNCH BREAK
=================================================== */
router.patch("/lunch/end", requireRole("student"), async (req, res) => {
  try {

    const studentId = req.user.student_id;

    await AttendanceModel.endLunchBreak(studentId, req.user.academic_year_id);

    res.json({
      success: true
    });

  } catch (err) {

    console.error("LUNCH END ERROR:", err);

    if (BUSINESS_ERRORS.includes(err.message)) {
      return res.status(400).json({
        message: err.message
      });
    }

    res.status(500).json({
      message: err.message || "Server error"
    });
  }
});

/* ===================================================
STUDENT: TIME OUT / END OT
=================================================== */
router.patch("/timeout", requireRole("student"), async (req, res) => {
  try {

    const studentId = req.user.student_id;

    await AttendanceModel.timeOutByStudent(studentId, req.user.academic_year_id);

    res.json({
      success: true
    });

  } catch (err) {

    console.error("TIMEOUT ERROR:", err);

    if (BUSINESS_ERRORS.includes(err.message)) {
      return res.status(400).json({
        message: err.message
      });
    }

    res.status(500).json({
      message: err.message || "Server error"
    });
  }
});

/* ===================================================
STUDENT: ATTENDANCE HISTORY
=================================================== */
router.get("/history", requireRole("student"), async (req, res) => {
  try {

    const studentId = req.user.student_id;

    const todayRow =
      await AttendanceModel.getToday(studentId, req.user.academic_year_id);

    const historyRows =
      await AttendanceModel.getStudentHistory(studentId, req.user.academic_year_id);

    // =========================
    // TODAY
    // =========================
    const today = todayRow
      ? {
          id: todayRow.attendance_id,

          date: todayRow.attendance_date,

          time_in:
            todayRow.display_time_in ?? todayRow.time_in,

          lunch_break_start:
            todayRow.lunch_break_start,

          lunch_break_end:
            todayRow.lunch_break_end,

          time_out:
            todayRow.time_out,

          ot_time_in:
            todayRow.ot_time_in,

          ot_time_out:
            todayRow.ot_time_out,

          start_time:
            todayRow.start_time,

          end_time:
            todayRow.end_time,

          early_attendance:
            todayRow.early_attendance,

          early_reason:
            todayRow.early_reason,

          early_status:
            todayRow.early_status,

          early_attachment_url:
            todayRow.early_attachment_url,

          early_attachment_public_id:
            todayRow.early_attachment_public_id,

          early_attachment_name:
            todayRow.early_attachment_name
        }
      : null;

    // =========================
    // HISTORY
    // =========================
    const history = historyRows.map(r => ({
      id: r.attendance_id,

      date: r.attendance_date,

      time_in:
        r.display_time_in ?? r.time_in,

      lunch_break_start:
        r.lunch_break_start,

      lunch_break_end:
        r.lunch_break_end,

      time_out:
        r.time_out,

      ot_time_in:
        r.ot_time_in,

      ot_time_out:
        r.ot_time_out,

      start_time:
        r.start_time,

      end_time:
        r.end_time,

      early_attendance:
        r.early_attendance,

      early_reason:
        r.early_reason,

      early_status:
        r.early_status,

      early_attachment_url:
        r.early_attachment_url,

      early_attachment_public_id:
        r.early_attachment_public_id,

      early_attachment_name:
        r.early_attachment_name
    }));

    res.json({
      success: true,
      today,
      history
    });

  } catch (err) {

    console.error(
      "ATTENDANCE HISTORY ERROR:",
      err
    );

    res.status(500).json({
      success: false
    });
  }
});

/* ===================================================
COORDINATOR: UPDATE LOCATION STATUS
=================================================== */
router.put("/:id/location-status", requireRole("coordinator"), async (req, res) => {
  try {

    const { id } = req.params;

    const { location_status } = req.body;

    await AttendanceModel.updateLocationStatus(
      id,
      location_status
    );

    res.json({
      success: true
    });

  } catch (err) {

    console.error(
      "UPDATE LOCATION STATUS ERROR:",
      err
    );

    res.status(500).json({
      message: "Failed to update location status"
    });
  }
});

/* ===================================================
COORDINATOR: PENDING EARLY ATTENDANCE
=================================================== */
router.get("/pending-early", requireRole("coordinator"), async (req, res) => {
  try {

    const data = await AttendanceModel.getPendingEarlyAttendance(
      req.user.academic_year_id,
      req.user.department_id
    );

    res.json(data);

  } catch (err) {

    console.error(
      "PENDING EARLY ATTENDANCE ERROR:",
      err
    );

    res.status(500).json({
      message: "Failed to fetch pending early attendance"
    });
  }
});

/* ===================================================
COORDINATOR: APPROVE EARLY ATTENDANCE
=================================================== */
router.patch("/early/:attendanceId/approve", requireRole("coordinator"), async (req, res) => {
  try {

    const { attendanceId } = req.params;

    await AttendanceModel.approveEarlyAttendance(
      attendanceId,
      req.user.academic_year_id
    );

    res.json({
      success: true,
      message: "Early attendance approved"
    });

  } catch (err) {

    console.error(
      "APPROVE EARLY ATTENDANCE ERROR:",
      err
    );

    res.status(500).json({
      message: "Server error"
    });
  }
});

/* ===================================================
COORDINATOR: REJECT EARLY ATTENDANCE
=================================================== */
router.patch("/early/:attendanceId/reject", requireRole("coordinator"), async (req, res) => {
  try {

    const { attendanceId } = req.params;

    await AttendanceModel.rejectEarlyAttendance(
      attendanceId,
      req.user.academic_year_id
    );

    res.json({
      success: true,
      message: "Early attendance rejected"
    });

  } catch (err) {

    console.error(
      "REJECT EARLY ATTENDANCE ERROR:",
      err
    );

    res.status(500).json({
      message: "Server error"
    });
  }
});

module.exports = router;