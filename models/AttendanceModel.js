const db = require("../config/db");
const { sendNotification } = require("../services/notificationServices");

function getPHTime() {
  return new Date().toLocaleTimeString("en-GB", {
    hour12: false,
    timeZone: "Asia/Manila"
  });
}

class AttendanceModel {

  // =========================
  // STUDENT ATTENDANCE
  // =========================
  static async getByStudent(student_id) {
    const [rows] = await db.query(`
      SELECT 
        attendance_id,
        student_id,
        time_in,
        time_out,
        latitude,
        longitude,
        created_at
      FROM attendance
      WHERE student_id = ?
      ORDER BY time_in DESC
    `, [student_id]);

    return rows;
  }

  // =========================
  // BY DEPARTMENT (coordinator)
  // =========================
  static async getByDepartment(department_id) {

    let sql = `
      SELECT
        a.attendance_id,
        a.student_id,
        a.time_in,
        NULLIF(a.time_out, '00:00:00') AS time_out,
        a.attendance_date,
        a.latitude,
        a.longitude,
        a.location_status,
        a.coordinator_note,
        u.f_name,
        u.l_name,
        u.photo
      FROM attendance a
      JOIN students s ON a.student_id = s.student_id
      JOIN users u ON s.user_id = u.user_id
      JOIN courses c ON s.course_id = c.course_id
    `;

    if (department_id) {
      sql += ` WHERE c.department_id = ? `;
      return (await db.query(sql, [department_id]))[0];
    }

    return (await db.query(sql))[0];
  }

  // =========================
  // CREATE TIME IN (GPS VERIFIED)
  // =========================
  static async timeIn({ student_id, latitude, longitude }) {

    const [existing] = await db.query(
      `SELECT attendance_id
       FROM attendance
       WHERE student_id = ?
       AND attendance_date = CURDATE()`,
      [student_id]
    );

    if (existing.length > 0) {
      return existing[0].attendance_id;
    }

    let location_status = "discrepancy";

    if (latitude && longitude) {

      const [[location]] = await db.query(`
        SELECT 
          l.latitude,
          l.longitude,
          l.radius_meters
        FROM students s
        JOIN ojt_locations l ON s.company_id = l.company_id
        WHERE s.student_id = ?
        LIMIT 1
      `, [student_id]);

      if (location) {

        const [[distanceResult]] = await db.query(`
          SELECT (
            6371000 * ACOS(
              COS(RADIANS(?)) *
              COS(RADIANS(?)) *
              COS(RADIANS(?) - RADIANS(?)) +
              SIN(RADIANS(?)) *
              SIN(RADIANS(?))
            )
          ) AS distance
        `, [
          latitude,
          location.latitude,
          location.longitude,
          longitude,
          latitude,
          location.latitude
        ]);

        const distance = distanceResult.distance || 999999;

        if (distance <= location.radius_meters) {
          location_status = "verified";
        } else {
          location_status = "discrepancy";
        }
      }
    }

    const now = getPHTime();

    const [result] = await db.query(`
      INSERT INTO attendance
      (student_id, attendance_date, time_in, latitude, longitude, location_status)
      VALUES (?, CURDATE(), ?, ?, ?, ?)
    `, [student_id, now, latitude ?? null, longitude ?? null, location_status]);

    return result.insertId;
  }

  // =========================
  // TIME OUT
  // =========================
  static async timeOutByStudent(student_id) {

    const now = getPHTime();

    await db.query(`
      UPDATE attendance
      SET time_out = ?
      WHERE student_id = ?
        AND attendance_date = CURDATE()
        AND time_out IS NULL
    `, [now, student_id]);

    await this.checkCompletionAndNotify(student_id);
  }

  // =========================
  // OJT COMPLETION CHECK
  // =========================
  static async checkCompletionAndNotify(student_id) {

    const [[row]] = await db.query(`
      SELECT 
        s.user_id,
        s.ojt_hours_required AS required_hours,
        IFNULL(
          SUM(TIME_TO_SEC(TIMEDIFF(a.time_out, a.time_in)) / 3600),
          0
        ) AS completed_hours
      FROM students s
      LEFT JOIN attendance a 
        ON s.student_id = a.student_id
        AND a.time_out IS NOT NULL
      WHERE s.student_id = ?
      GROUP BY s.user_id, s.ojt_hours_required
    `, [student_id]);

    if (!row) return;
    if (row.completed_hours < row.required_hours) return;

    const [[existing]] = await db.query(`
      SELECT notif_id
      FROM notifications
      WHERE user_id = ?
        AND title = 'OJT Completed'
      LIMIT 1
    `, [row.user_id]);

    if (existing) return;

    await sendNotification(
      row.user_id,
      "OJT Completed",
      "Congratulations! You have successfully completed your required OJT hours."
    );
  }

  // =========================
  // HOURS COMPLETED
  // =========================
  static async getHoursByStudent(student_id) {

    const [[row]] = await db.query(`
      SELECT IFNULL(
        SUM(TIME_TO_SEC(TIMEDIFF(time_out, time_in)) / 3600),
        0
      ) AS hours
      FROM attendance
      WHERE student_id = ?
      AND time_out IS NOT NULL
    `, [student_id]);

    return row.hours;
  }

  // =========================
  // TODAY ATTENDANCE
  // =========================
  static async getToday(student_id) {

    const [rows] = await db.query(`
      SELECT 
        attendance_id,
        attendance_date,
        TIME(time_in) AS time_in,
        TIME(time_out) AS time_out
      FROM attendance
      WHERE student_id = ?
      AND attendance_date = CURDATE()
      ORDER BY attendance_id DESC
      LIMIT 1
    `, [student_id]);

    return rows[0] || null;
  }

  // =========================
  // STUDENT ATTENDANCE HISTORY
  // =========================
  static async getStudentHistory(student_id) {

    const [rows] = await db.query(`
      SELECT 
        attendance_id,
        attendance_date,
        TIME(time_in) AS time_in,
        TIME(time_out) AS time_out
      FROM attendance
      WHERE student_id = ?
      ORDER BY attendance_date DESC, time_in DESC
    `, [student_id]);

    return rows;
  }

  // =========================
  // UPDATE LOCATION STATUS (coordinator)
  // =========================
  static async updateLocationStatus(attendance_id, location_status) {

    const [result] = await db.query(
      `UPDATE attendance
       SET location_status = ?
       WHERE attendance_id = ?`,
      [location_status, attendance_id]
    );

    console.log("Rows affected:", result.affectedRows);
  }

}

module.exports = AttendanceModel;