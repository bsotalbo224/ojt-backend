const db = require("../config/db");

class ProgressModel {

  // ─────────────────────────────────────────
  // STUDENT HOURS + COMPANY + BASIC INFO
  // ─────────────────────────────────────────
  static async getStudentHours(student_id) {
    const [rows] = await db.query(`
      SELECT
        MAX(s.ojt_hours_required) AS required_hours,
        MAX(c.company_name) AS company_name,

        MAX(CONCAT(u.f_name, ' ', u.l_name)) AS student_name,
        MAX(d.department_name) AS department_name,
        MAX(crs.course_name) AS course_name,

        MAX(CONCAT(cu.f_name, ' ', cu.l_name)) AS coordinator_name,

        ROUND(
          IFNULL(SUM(TIMESTAMPDIFF(MINUTE,a.time_in,a.time_out))/60,0),
          2
        ) AS completed_hours

      FROM students s
      LEFT JOIN users u 
        ON u.user_id = s.user_id

      LEFT JOIN companies c 
        ON c.company_id = s.company_id

      LEFT JOIN departments d 
        ON d.department_id = s.department_id

      LEFT JOIN courses crs 
        ON crs.course_id = s.course_id

      LEFT JOIN coordinators co 
        ON co.department_id = s.department_id

      LEFT JOIN users cu 
        ON cu.user_id = co.user_id

      LEFT JOIN attendance a 
        ON a.student_id = s.student_id
        AND a.time_in IS NOT NULL
        AND a.time_out IS NOT NULL

      WHERE s.student_id = ?
      GROUP BY s.student_id
      LIMIT 1
    `, [student_id]);

    return rows[0] || null;
  }

  // ─────────────────────────────────────────
  // DAILY LOG STATISTICS
  // ─────────────────────────────────────────
  static async getDailyLogStats(student_id) {
    const [rows] = await db.query(`
      SELECT
        COUNT(*) AS total,
        IFNULL(SUM(status='approved'),0) AS approved,
        IFNULL(SUM(status='submitted'),0) AS submitted,
        IFNULL(SUM(status='revision'),0) AS needsRevision
      FROM daily_logs
      WHERE student_id = ?
    `, [student_id]);

    return rows[0] || {
      total: 0,
      approved: 0,
      submitted: 0,
      needsRevision: 0
    };
  }

  // ─────────────────────────────────────────
  // NARRATIVE REPORT STATISTICS
  // ─────────────────────────────────────────
  static async getNarrativeStats(student_id) {
    const [rows] = await db.query(`
      SELECT
        COUNT(*) AS total,
        IFNULL(SUM(status='approved'),0) AS approved,
        IFNULL(SUM(status='submitted'),0) AS submitted,
        IFNULL(SUM(status='revision'),0) AS revision
      FROM narrative_reports
      WHERE student_id = ?
    `, [student_id]);

    return rows[0] || {
      total: 0,
      approved: 0,
      submitted: 0,
      revision: 0
    };
  }

  // ─────────────────────────────────────────
  // ATTENDANCE STATISTICS
  // ─────────────────────────────────────────
  static async getAttendanceStats(student_id) {

    const [rows] = await db.query(`
      SELECT
        COUNT(DISTINCT attendance_date) AS totalDays,

        ROUND(
          IFNULL(SUM(TIMESTAMPDIFF(MINUTE,time_in,time_out))/60,0),
          2
        ) AS totalHours,

        MIN(attendance_date) AS firstDate,
        MAX(attendance_date) AS lastDate

      FROM attendance
      WHERE student_id = ?
        AND time_in IS NOT NULL
        AND time_out IS NOT NULL
    `, [student_id]);

    const r = rows[0] || {};

    const avgHoursPerDay =
      r.totalDays > 0
        ? Number((r.totalHours / r.totalDays).toFixed(2))
        : 0;

    return {
      totalDays: r.totalDays || 0,
      totalHours: r.totalHours || 0,
      avgHoursPerDay,
      firstDate: r.firstDate || null,
      lastDate: r.lastDate || null
    };
  }

}

module.exports = ProgressModel;