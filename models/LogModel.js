const db = require("../config/db");
const { sendNotification } = require("../services/notificationServices");

class LogModel {

  // =========================
  // STUDENT LOGS
  // =========================
  static async getByStudent(student_id) {
    const [rows] = await db.query(`
      SELECT 
        l.*,

        a.morning_time_in,
        a.morning_time_out,
        a.afternoon_time_in,
        a.afternoon_time_out,
        a.ot_time_in,
        a.ot_time_out,

        ROUND(
          (
            IFNULL(TIME_TO_SEC(TIMEDIFF(a.morning_time_out, a.morning_time_in)),0) +
            IFNULL(TIME_TO_SEC(TIMEDIFF(a.afternoon_time_out, a.afternoon_time_in)),0) +
            IFNULL(TIME_TO_SEC(TIMEDIFF(a.ot_time_out, a.ot_time_in)),0)
          ) / 3600,
          2
        ) AS total_hours,

        (
          SELECT COUNT(*)
          FROM attachments att
          WHERE att.log_id = l.log_id
        ) AS attachment_count

      FROM daily_logs l
      LEFT JOIN attendance a
        ON l.student_id = a.student_id
        AND l.log_date = a.attendance_date
      WHERE l.student_id = ?
      ORDER BY l.log_date DESC
    `, [student_id]);

    return rows;
  }

  // =========================
  // CREATE LOG
  // =========================
  static async create(data) {

    const { student_id, log_date, narrative } = data;

    const [[attendance]] = await db.query(`
      SELECT *
      FROM attendance
      WHERE student_id = ?
        AND attendance_date = ?
        AND (
          morning_time_out IS NOT NULL OR
          afternoon_time_out IS NOT NULL OR
          ot_time_out IS NOT NULL
        )
    `, [student_id, log_date]);

    if (!attendance) {
      throw new Error("Attendance not completed for this date.");
    }

    const [result] = await db.query(`
      INSERT INTO daily_logs
      (student_id, log_date, narrative, status)
      VALUES (?, ?, ?, 'submitted')
    `, [student_id, log_date, narrative]);

    return result.insertId;
  }

  // =========================
  // SINGLE LOG
  // =========================
  static async getById(log_id) {
    const [[log]] = await db.query(`
      SELECT 
        l.*,

        a.morning_time_in,
        a.morning_time_out,
        a.afternoon_time_in,
        a.afternoon_time_out,
        a.ot_time_in,
        a.ot_time_out,

        ROUND(
          (
            IFNULL(TIME_TO_SEC(TIMEDIFF(a.morning_time_out, a.morning_time_in)),0) +
            IFNULL(TIME_TO_SEC(TIMEDIFF(a.afternoon_time_out, a.afternoon_time_in)),0) +
            IFNULL(TIME_TO_SEC(TIMEDIFF(a.ot_time_out, a.ot_time_in)),0)
          ) / 3600,
          2
        ) AS total_hours

      FROM daily_logs l
      LEFT JOIN attendance a
        ON l.student_id = a.student_id
        AND l.log_date = a.attendance_date
      WHERE l.log_id = ?
    `, [log_id]);

    return log || null;
  }

}

module.exports = LogModel;