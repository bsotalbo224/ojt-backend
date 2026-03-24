const db = require("../config/db");

exports.getReportSummary = async (req, res) => {
  try {
    //  Get student_id using user_id from JWT
    const [studentRows] = await db.query(
      "SELECT student_id FROM students WHERE user_id = ?",
      [req.user.id]
    );

    if (!studentRows.length) {
      return res.status(404).json({ message: "Student record not found" });
    }

    const studentId = studentRows[0].student_id;

    // Attendance summary
    const [attendance] = await db.query(
      "SELECT COUNT(*) AS total FROM attendance WHERE student_id = ?",
      [studentId]
    );

    // Daily logs summary
    const [logs] = await db.query(
      "SELECT COUNT(*) AS total FROM daily_logs WHERE student_id = ?",
      [studentId]
    );

    // Narrative reports summary
    const [narrative] = await db.query(
      "SELECT COUNT(*) AS total FROM narrative_reports WHERE student_id = ?",
      [studentId]
    );

    // Response
    res.json({
      dtr: {
        total_entries: attendance[0].total
      },
      daily_logs: {
        total_days: logs[0].total
      },
      narrative: {
        ready: narrative[0].total > 0
      }
    });

  } catch (err) {
    console.error("REPORT SUMMARY ERROR:", err);
    res.status(500).json({ message: "Failed to load report summary" });
  }
};
