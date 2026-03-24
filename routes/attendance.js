const express = require("express");
const router = express.Router();

const AttendanceModel = require("../models/AttendanceModel");
const { requireAuth } = require("../middleware/authMiddleware");
const { requireRole } = require("../middleware/roleMiddleware");

router.use(requireAuth);

/* ===================================================
STUDENT: MY ATTENDANCE
=================================================== */
router.get("/student", requireRole("student"), async (req, res) => {
  try {
    const studentId = req.user.student_id;
    const data = await AttendanceModel.getToday(studentId);
    res.json(data);
  } catch (err) {
    console.error("STUDENT ATTENDANCE ERROR:", err);
    res.status(500).json({ message: "Server error" });
  }
});

/* ===================================================
COORDINATOR: DEPARTMENT ATTENDANCE
=================================================== */
router.get("/coordinator", requireRole("coordinator"), async (req, res) => {
  try {
    const deptId = req.user.department_id;
    const data = await AttendanceModel.getByDepartment(deptId);
    res.json(data);
  } catch (err) {
    console.error("COORD ATTENDANCE ERROR:", err);
    res.status(500).json({ message: "Server error" });
  }
});

/* ===================================================
ADMIN: ALL ATTENDANCE
=================================================== */
router.get("/admin", requireRole("admin"), async (req, res) => {
  try {
    const data = await AttendanceModel.getByDepartment(null);
    res.json(data);
  } catch (err) {
    console.error("ADMIN ATTENDANCE ERROR:", err);
    res.status(500).json({ message: "Server error" });
  }
});

/* ===================================================
STUDENT: TIME IN
=================================================== */
router.post("/timein", requireRole("student"), async (req, res) => {
  try {
    const studentId = req.user.student_id;
    const { latitude, longitude } = req.body;

    const id = await AttendanceModel.timeIn({
      student_id: studentId,
      latitude,
      longitude
    });

    res.json({ attendance_id: id });
  } catch (err) {
    console.error("TIMEIN ERROR:", err);
    res.status(500).json({ message: err.message || "Server error" });
  }
});

/* ===================================================
STUDENT: TIME OUT
=================================================== */
router.patch("/timeout", requireRole("student"), async (req, res) => {
  try {
    const studentId = req.user.student_id;

    await AttendanceModel.timeOutByStudent(studentId);

    res.json({ success: true });
  } catch (err) {
    console.error("TIMEOUT ERROR:", err);
    res.status(500).json({ message: err.message || "Server error" });
  }
});

/* ===================================================
STUDENT: ATTENDANCE HISTORY
=================================================== */
router.get("/history", requireRole("student"), async (req, res) => {
  try {
    const studentId = req.user.student_id;

    const todayRow = await AttendanceModel.getToday(studentId);
    const historyRows = await AttendanceModel.getStudentHistory(studentId);

    const today = todayRow
      ? {
          id: todayRow.attendance_id,
          date: todayRow.attendance_date,
          timeIn: todayRow.time_in,
          timeOut: todayRow.time_out
        }
      : null;

    const history = historyRows.map(r => ({
      id: r.attendance_id,
      date: r.attendance_date,
      timeIn: r.time_in,
      timeOut: r.time_out
    }));

    res.json({
      success: true,
      today,
      history
    });

  } catch (err) {
    console.error("ATTENDANCE HISTORY ERROR:", err);
    res.status(500).json({ success: false });
  }
});

/* ===================================================
COORDINATOR: UPDATE LOCATION STATUS
=================================================== */
router.put("/:id/location-status", requireRole("coordinator"), async (req, res) => {
  try {
    const { id } = req.params;
    const { location_status } = req.body;

    console.log("UPDATE LOCATION:", id, location_status);

    await AttendanceModel.updateLocationStatus(id, location_status);

    res.json({ success: true });
  } catch (err) {
    console.error("UPDATE LOCATION STATUS ERROR:", err);
    res.status(500).json({ message: "Failed to update location status" });
  }
});

module.exports = router;
