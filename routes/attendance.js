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
  "Time in first",
  "Lunch break not required for this shift",
  "Lunch break not started",
  "Lunch break already started",
  "Lunch break already ended",
  "OT already started",
  "Attendance already completed",
  "Attendance not found or unauthorized",
  "Early attendance request is already processed or not found",
  "Reason is required for early attendance.",
  "Attachment is required for early attendance."
];

/* ===================================================
SHARED ROUTE ERROR HANDLER
Logs the error, returns 400 for known business validation
errors (using their exact message), and falls back to 500
with a generic message for anything unexpected.
=================================================== */
function handleRouteError(res, err, logLabel, fallbackMessage = "Server error") {
  console.error(`${logLabel}:`, err);

  if (BUSINESS_ERRORS.includes(err.message)) {
    return res.status(400).json({
      message: err.message
    });
  }

  return res.status(500).json({
    message: fallbackMessage
  });
}

function mapAttendanceRow(r) {
  return {
    attendance_id: r.attendance_id,

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
  };
}

/* ===================================================
STUDENT: MY ATTENDANCE (TODAY)
=================================================== */
router.get("/student", requireRole("student"), async (req, res) => {
  try {

    const studentId = req.user.student_id;

    const data = await AttendanceModel.getToday(studentId, req.user.academic_year_id);

    res.json(data);

  } catch (err) {
    return handleRouteError(res, err, "STUDENT ATTENDANCE ERROR");
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
    return handleRouteError(res, err, "COORD ATTENDANCE ERROR");
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
          req.user.academic_year_id,
          req.user.department_id
        );

      res.json(data);

    } catch (err) {
      return handleRouteError(res, err, "STUDENT ATTENDANCE RECORDS ERROR");
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
    return handleRouteError(res, err, "ADMIN ATTENDANCE ERROR");
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
      return handleRouteError(res, err, "TIMEIN ERROR");
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
    return handleRouteError(res, err, "LUNCH START ERROR");
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
    return handleRouteError(res, err, "LUNCH END ERROR");
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
    return handleRouteError(res, err, "TIMEOUT ERROR");
  }
});

/* ===================================================
STUDENT: ATTENDANCE HISTORY (PAGINATED)
=================================================== */
router.get("/history", requireRole("student"), async (req, res) => {
  try {

    const studentId = req.user.student_id;

    // =========================
    // PARSE PAGINATION QUERY PARAMS (sanitized)
    // =========================
    const page = Math.max(
      parseInt(req.query.page, 10) || 1,
      1
    );

    const limit = Math.min(
      Math.max(parseInt(req.query.limit, 10) || 15, 1),
      100
    );

    const todayRow =
      await AttendanceModel.getToday(studentId, req.user.academic_year_id);

    const historyResult =
      await AttendanceModel.getStudentHistory(
        studentId,
        req.user.academic_year_id,
        page,
        limit
      );

    const {
      data: historyRows,
      pagination
    } = historyResult;

    // =========================
    // TODAY
    // =========================
    const today = todayRow
  ? mapAttendanceRow(todayRow)
  : null;

    // =========================
    // HISTORY
    // =========================
    const history = historyRows.map(mapAttendanceRow);

    res.json({
      success: true,
      today,
      history,
      pagination
    });

  } catch (err) {
    return handleRouteError(res, err, "ATTENDANCE HISTORY ERROR");
  }
});

/* ===================================================
STUDENT: ATTENDANCE HISTORY EXPORT (FULL, NO PAGINATION)
Used only for PDF export — always returns ALL attendance rows.
=================================================== */
router.get("/history/export", requireRole("student"), async (req, res) => {
  try {

    const studentId = req.user.student_id;

    const rows =
      await AttendanceModel.getStudentHistoryForExport(
        studentId,
        req.user.academic_year_id
      );

    const history = rows.map(mapAttendanceRow);

    res.json({
      success: true,
      history
    });

  } catch (err) {
    return handleRouteError(res, err, "ATTENDANCE HISTORY EXPORT ERROR");
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
      location_status,
      req.user.academic_year_id,
      req.user.department_id
    );

    res.json({
      success: true
    });

  } catch (err) {
    return handleRouteError(res, err, "UPDATE LOCATION STATUS ERROR", "Failed to update location status");
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
    return handleRouteError(res, err, "PENDING EARLY ATTENDANCE ERROR", "Failed to fetch pending early attendance");
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
      req.user.academic_year_id,
      req.user.department_id
    );

    res.json({
      success: true,
      message: "Early attendance approved"
    });

  } catch (err) {
    return handleRouteError(res, err, "APPROVE EARLY ATTENDANCE ERROR");
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
      req.user.academic_year_id,
      req.user.department_id
    );

    res.json({
      success: true,
      message: "Early attendance rejected"
    });

  } catch (err) {
    return handleRouteError(res, err, "REJECT EARLY ATTENDANCE ERROR");
  }
});

module.exports = router;