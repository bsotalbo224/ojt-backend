const db = require("../config/db");
const { sendNotification } = require("../services/notificationServices");

class LogModel {

  // =========================
  // STUDENT LOGS (with attachment count)
  // =========================
  static async getByStudent(student_id) {
    const [rows] = await db.query(`
      SELECT 
        l.*,
        a.time_in,
        a.time_out,
        TIMESTAMPDIFF(HOUR, a.time_in, a.time_out) AS total_hours,

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
  // BY DEPARTMENT (coordinator)
  // =========================
  static async getByDepartment(department_id) {

    let query = `
      SELECT 
        l.*,
        a.time_in,
        a.time_out,
        TIMESTAMPDIFF(HOUR, a.time_in, a.time_out) AS total_hours,
        u.f_name,
        u.l_name,
        CONCAT(u.f_name,' ',u.l_name) AS student_name,
        u.photo,
        c.course_code
      FROM daily_logs l
      JOIN students s ON l.student_id = s.student_id
      JOIN users u ON s.user_id = u.user_id
      JOIN courses c ON s.course_id = c.course_id
      LEFT JOIN attendance a
        ON l.student_id = a.student_id
        AND l.log_date = a.attendance_date
    `;

    const params = [];

    if (department_id) {
      query += ` WHERE c.department_id = ?`;
      params.push(department_id);
    }

    query += ` ORDER BY l.log_date DESC`;

    const [rows] = await db.query(query, params);
    return rows;
  }

  // =========================
  // CREATE LOG (student)
  // =========================
  static async create(data) {

    const { student_id, log_date, narrative } = data;

    // Check attendance completed
    const [[attendance]] = await db.query(`
      SELECT *
      FROM attendance
      WHERE student_id = ?
        AND attendance_date = ?
        AND time_out IS NOT NULL
    `, [student_id, log_date]);

    if (!attendance) {
      throw new Error("Attendance not completed for this date.");
    }

    try {

      const [result] = await db.query(`
        INSERT INTO daily_logs
        (student_id, log_date, narrative, status)
        VALUES (?, ?, ?, 'submitted')
      `, [student_id, log_date, narrative]);

      // Notify coordinator
      const [[coord]] = await db.query(`
        SELECT co.user_id
        FROM students s
        JOIN courses c ON s.course_id = c.course_id
        JOIN coordinators co ON co.department_id = c.department_id
        WHERE s.student_id = ?
      `, [student_id]);

      if (coord?.user_id) {

        await sendNotification({
          user_id: coord.user_id,
          title: "New Daily Log Submitted",
          message: "A student submitted a new daily OJT log.",
          type: "log",
          link: "/coordinator/daily-logs"
        });

      }

      return result.insertId;

    } catch (err) {

      if (err.code === "ER_DUP_ENTRY") {
        throw new Error("You already submitted a log for this date.");
      }

      throw err;
    }
  }

  // =========================
  // ADD ATTACHMENT
  // =========================
  static async addAttachment(data) {

    const { log_id, file_name, file_path, file_type } = data;

    await db.query(`
      INSERT INTO attachments
      (log_id, file_name, file_path, file_type)
      VALUES (?, ?, ?, ?)
    `, [log_id, file_name, file_path, file_type]);

  }

  // =========================
  // UPDATE STATUS (coordinator)
  // =========================
  static async updateStatus(log_id, status, remarks) {

    await db.query(`
      UPDATE daily_logs
      SET status = ?, feedback = ?
      WHERE log_id = ?
    `, [status, remarks, log_id]);

    // Get student info
    const [[row]] = await db.query(`
      SELECT 
        s.user_id,
        l.log_date
      FROM daily_logs l
      JOIN students s ON l.student_id = s.student_id
      WHERE l.log_id = ?
    `, [log_id]);

    if (!row?.user_id) return;

    let title;
    let message;

    if (status === "approved") {
      title = "Daily Log Approved";
      message = "Your daily OJT log has been approved.";
    }

    else if (status === "revision") {
      title = "Coordinator Feedback";
      message = "Your daily log has feedback and needs revision.";
    }

    else {
      title = "Daily Log Updated";
      message = "Your daily log status changed.";
    }

    // =========================
    // SEND NOTIFICATION
    // =========================

    let link = "/student/logs";

    if (status === "revision") {
      link = `/student/logs?revision=${log_id}`;
    }

    await sendNotification({
      user_id: row.user_id,
      title,
      message,
      type: "feedback",
      link
    });

    // =========================
    // CONSULTATION SYSTEM MESSAGE
    // =========================
    if (status === "revision") {

      await db.query(`
        INSERT INTO messages
        (sender_id, receiver_id, message, message_type, related_log_id)
        VALUES (?, ?, ?, 'system', ?)
      `, [
        null,
        row.user_id,
        `Coordinator commented on your Daily Log (${row.log_date})`,
        log_id
      ]);

    }

  }

  // =========================
  // SINGLE LOG WITH ATTACHMENTS
  // =========================
  static async getById(log_id) {

    const [[log]] = await db.query(`
      SELECT 
        l.*,
        l.feedback AS coordinator_feedback,
        s.student_id,
        c.department_id,
        CONCAT(u.f_name,' ',u.l_name) AS student_name,
        c.course_code
      FROM daily_logs l
      JOIN students s ON l.student_id = s.student_id
      JOIN users u ON s.user_id = u.user_id
      JOIN courses c ON s.course_id = c.course_id
      WHERE l.log_id = ?
    `, [log_id]);

    if (!log) return null;

    const [attachments] = await db.query(`
      SELECT 
        attachment_id,
        file_name,
        file_path,
        file_type,
        uploaded_at
      FROM attachments
      WHERE log_id = ?
      ORDER BY uploaded_at ASC
    `, [log_id]);

    log.attachments = attachments;

    return log;
  }

  // =========================
  // UPDATE LOG (student revision)
  // =========================
  static async updateByStudent(log_id, student_id, data) {

    const { narrative } = data;

    const [result] = await db.query(`
      UPDATE daily_logs
      SET narrative = ?,
          status = 'submitted'
      WHERE log_id = ?
        AND student_id = ?
    `, [narrative, log_id, student_id]);

    // notify coordinator
    const [[coord]] = await db.query(`
      SELECT co.user_id
      FROM students s
      JOIN courses c ON s.course_id = c.course_id
      JOIN coordinators co ON co.department_id = c.department_id
      WHERE s.student_id = ?
    `, [student_id]);

    if (coord?.user_id) {

      await sendNotification({
        user_id: coord.user_id,
        title: "Revised Daily Log Submitted",
        message: "A student resubmitted a revised daily log.",
        type: "log",
        link: "/coordinator/daily-logs"
      });

    }

    return result.affectedRows;
  }

  // =========================
  // GET ATTACHMENT
  // =========================
  static async getAttachmentById(attachment_id) {

    const [[file]] = await db.query(`
      SELECT 
        a.attachment_id,
        a.file_name,
        a.file_path,
        a.file_type,
        a.uploaded_at,
        l.student_id,
        c.department_id
      FROM attachments a
      JOIN daily_logs l ON a.log_id = l.log_id
      JOIN students s ON l.student_id = s.student_id
      JOIN courses c ON s.course_id = c.course_id
      WHERE a.attachment_id = ?
    `, [attachment_id]);

    if (!file) return null;

    return file;
  }

}

module.exports = LogModel;