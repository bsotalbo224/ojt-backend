const db = require("../config/db");
const { sendNotification } = require("../services/notificationServices");

function getPHTime() {
  const now = new Date();
  now.setHours(now.getHours() + 8);

  const hours = String(now.getHours()).padStart(2, "0");
  const minutes = String(now.getMinutes()).padStart(2, "0");
  const seconds = String(now.getSeconds()).padStart(2, "0");

  return `${hours}:${minutes}:${seconds}`;
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
        attendance_date,
        morning_time_in,
        morning_time_out,
        afternoon_time_in,
        afternoon_time_out,
        ot_time_in,
        ot_time_out,
        latitude,
        longitude,
        created_at
      FROM attendance
      WHERE student_id = ?
      ORDER BY attendance_date DESC
    `, [student_id]);

    return rows;
  }

  // =========================
  // BY DEPARTMENT
  // =========================
  static async getByDepartment(department_id) {

    let sql = `
      SELECT
        a.attendance_id,
        a.student_id,
        a.attendance_date,
        a.morning_time_in,
        a.morning_time_out,
        a.afternoon_time_in,
        a.afternoon_time_out,
        a.ot_time_in,
        a.ot_time_out,
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
  // SMART TIME IN
  // =========================
  static async timeIn({ student_id, latitude, longitude }) {

    const now = getPHTime();

    const [[today]] = await db.query(`
      SELECT * FROM attendance
      WHERE student_id = ?
      AND attendance_date = CURDATE()
    `, [student_id]);

    // LOCATION CHECK (unchanged)
    let location_status = "flagged";

    if (latitude && longitude) {
      const [[location]] = await db.query(`
        SELECT latitude, longitude, radius_meters
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

        if ((distanceResult.distance || 999999) <= location.radius_meters) {
          location_status = "verified";
        }
      }
    }

    // CREATE NEW RECORD → MORNING IN
    if (!today) {
      const [result] = await db.query(`
        INSERT INTO attendance
        (student_id, attendance_date, morning_time_in, latitude, longitude, location_status)
        VALUES (?, CURDATE(), ?, ?, ?, ?)
      `, [student_id, now, latitude ?? null, longitude ?? null, location_status]);

      return result.insertId;
    }

    // BLOCK duplicate morning in
    if (today.morning_time_in && !today.morning_time_out) {
      throw new Error("Already timed in (morning)");
    }

    // AFTERNOON IN
    if (!today.afternoon_time_in) {
      await db.query(`
        UPDATE attendance
        SET afternoon_time_in = ?
        WHERE attendance_id = ?
      `, [now, today.attendance_id]);
      return;
    }

    // OT IN
    if (!today.ot_time_in) {
      await db.query(`
        UPDATE attendance
        SET ot_time_in = ?
        WHERE attendance_id = ?
      `, [now, today.attendance_id]);
    }
  }

  // =========================
  // SMART TIME OUT
  // =========================
  static async timeOutByStudent(student_id) {

    const now = getPHTime();

    const [[today]] = await db.query(`
      SELECT * FROM attendance
      WHERE student_id = ?
      AND attendance_date = CURDATE()
    `, [student_id]);

    if (!today) throw new Error("No time-in found");

    // MORNING OUT
    if (today.morning_time_in && !today.morning_time_out) {
      await db.query(`
        UPDATE attendance
        SET morning_time_out = ?
        WHERE attendance_id = ?
      `, [now, today.attendance_id]);
      return;
    }

    // AFTERNOON OUT (AUTO 1PM IF MISSING)
    if (!today.afternoon_time_out) {
      await db.query(`
        UPDATE attendance
        SET 
          afternoon_time_in = COALESCE(afternoon_time_in, '13:00:00'),
          afternoon_time_out = ?
        WHERE attendance_id = ?
      `, [now, today.attendance_id]);
      return;
    }

    // OT OUT
    if (today.ot_time_in && !today.ot_time_out) {
      await db.query(`
        UPDATE attendance
        SET ot_time_out = ?
        WHERE attendance_id = ?
      `, [now, today.attendance_id]);
    }

    await this.checkCompletionAndNotify(student_id);
  }

  // =========================
  // HOURS COMPUTATION
  // =========================
  static async getHoursByStudent(student_id) {

    const [[row]] = await db.query(`
      SELECT IFNULL(
        SUM(
          (
            IFNULL(TIME_TO_SEC(TIMEDIFF(morning_time_out, morning_time_in)), 0) +
            IFNULL(TIME_TO_SEC(TIMEDIFF(afternoon_time_out, afternoon_time_in)), 0) +
            IFNULL(TIME_TO_SEC(TIMEDIFF(ot_time_out, ot_time_in)), 0)
          ) / 3600
        ),
        0
      ) AS hours
      FROM attendance
      WHERE student_id = ?
    `, [student_id]);

    return row.hours;
  }

  // =========================
  // COMPLETION CHECK
  // =========================
  static async checkCompletionAndNotify(student_id) {

    const [[row]] = await db.query(`
      SELECT 
        s.user_id,
        s.ojt_hours_required AS required_hours,
        IFNULL(
          SUM(
            (
              IFNULL(TIME_TO_SEC(TIMEDIFF(a.morning_time_out, a.morning_time_in)), 0) +
              IFNULL(TIME_TO_SEC(TIMEDIFF(a.afternoon_time_out, a.afternoon_time_in)), 0) +
              IFNULL(TIME_TO_SEC(TIMEDIFF(a.ot_time_out, a.ot_time_in)), 0)
            ) / 3600
          ),
          0
        ) AS completed_hours
      FROM students s
      LEFT JOIN attendance a ON s.student_id = a.student_id
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
  // TODAY
  // =========================
  static async getToday(student_id) {

    const [rows] = await db.query(`
      SELECT 
        attendance_id,
        attendance_date,
        morning_time_in,
        morning_time_out,
        afternoon_time_in,
        afternoon_time_out,
        ot_time_in,
        ot_time_out
      FROM attendance
      WHERE student_id = ?
      AND attendance_date = CURDATE()
      LIMIT 1
    `, [student_id]);

    return rows[0] || null;
  }

  // =========================
  // HISTORY
  // =========================
  static async getStudentHistory(student_id) {

    const [rows] = await db.query(`
      SELECT 
        attendance_id,
        attendance_date,
        morning_time_in,
        morning_time_out,
        afternoon_time_in,
        afternoon_time_out,
        ot_time_in,
        ot_time_out
      FROM attendance
      WHERE student_id = ?
      ORDER BY attendance_date DESC
    `, [student_id]);

    return rows;
  }

  // =========================
  // UPDATE LOCATION STATUS
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