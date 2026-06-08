const db = require("../config/db");
const { sendNotification } = require("../services/notificationServices");

class LogModel {

  // =========================
  // STUDENT LOGS
  // =========================
  static async getByStudent(
    student_id,
    academic_year_id
  ) {
    const [rows] = await db.query(`
      SELECT 
        l.*,

        a.time_in,
        a.lunch_break_start,
        a.lunch_break_end,
        a.time_out,
        a.ot_time_in,
        a.ot_time_out,

        ROUND(
          (
            (
              IFNULL(
                TIME_TO_SEC(TIMEDIFF(a.time_out, a.time_in)),
                0
              )

              - IF(
                  a.lunch_break_start IS NOT NULL
                  AND a.lunch_break_end IS NOT NULL,

                  TIME_TO_SEC(
                    TIMEDIFF(
                      a.lunch_break_end,
                      a.lunch_break_start
                    )
                  ),

                  IF(
                    IFNULL(
                      TIME_TO_SEC(TIMEDIFF(a.time_out, a.time_in)),
                      0
                    ) >= 18000,
                    3600,
                    0
                  )
                )
            )

            + IFNULL(
                TIME_TO_SEC(
                  TIMEDIFF(a.ot_time_out, a.ot_time_in)
                ),
                0
              )
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
      AND l.academic_year_id = ?
      ORDER BY l.log_date DESC
    `, [
      student_id,
      academic_year_id
    ]);

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
        AND time_out IS NOT NULL
    `, [student_id, log_date]);

    if (!attendance) {
      throw new Error("Attendance not completed for this date.");
    }

    const [[student]] = await db.query(`
      SELECT academic_year_id
      FROM students
      WHERE student_id = ?
    `, [student_id]);

    const [result] = await db.query(`
      INSERT INTO daily_logs (
        student_id,
        academic_year_id,
        log_date,
        narrative,
        status
      )
      VALUES (
        ?, ?, ?, ?, 'submitted'
      )
    `, [
      student_id,
      student.academic_year_id,
      log_date,
      narrative
    ]);

    const [[coord]] = await db.query(`
      SELECT co.user_id
      FROM students s
      JOIN courses c
        ON s.course_id = c.course_id
      JOIN coordinators co
        ON co.department_id = c.department_id
      WHERE s.student_id = ?
      LIMIT 1
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
  }

  // =========================
  // SINGLE LOG
  // =========================
  static async getById(log_id, academic_year_id) {

    const [[log]] = await db.query(`
    SELECT
      l.*,

      s.student_id,
      s.department_id,

      u.f_name,
      u.l_name,
      CONCAT(u.f_name,' ',u.l_name) AS student_name,
      u.photo,

      cr.course_code AS course,
      d.department_name,
      comp.company_name,

      s.start_time,
      s.end_time,

      a.time_in,
      a.lunch_break_start,
      a.lunch_break_end,
      a.time_out,

      a.time_in AS morning_time_in,
      a.lunch_break_start AS morning_time_out,

      a.lunch_break_end AS afternoon_time_in,
      a.time_out AS afternoon_time_out,

      a.ot_time_in,
      a.ot_time_out,

      ROUND(
        (
          (
            IFNULL(
              TIME_TO_SEC(TIMEDIFF(a.time_out, a.time_in)),
              0
            )

            - IF(
                a.lunch_break_start IS NOT NULL
                AND a.lunch_break_end IS NOT NULL,

                TIME_TO_SEC(
                  TIMEDIFF(
                    a.lunch_break_end,
                    a.lunch_break_start
                  )
                ),

                IF(
                  IFNULL(
                    TIME_TO_SEC(TIMEDIFF(a.time_out, a.time_in)),
                    0
                  ) >= 18000,
                  3600,
                  0
                )
              )
          )

          + IFNULL(
              TIME_TO_SEC(
                TIMEDIFF(a.ot_time_out, a.ot_time_in)
              ),
              0
            )
        ) / 3600,
        2
      ) AS total_hours,

      (
        SELECT COUNT(*)
        FROM attachments att
        WHERE att.log_id = l.log_id
      ) AS attachment_count

    FROM daily_logs l

    JOIN students s
      ON s.student_id = l.student_id

    JOIN users u
      ON u.user_id = s.user_id

    LEFT JOIN courses cr
      ON cr.course_id = s.course_id

    LEFT JOIN departments d
      ON d.department_id = s.department_id

    LEFT JOIN companies comp
      ON comp.company_id = s.company_id  

    LEFT JOIN attendance a
      ON l.student_id = a.student_id
      AND l.log_date = a.attendance_date

    WHERE l.log_id = ?
    AND l.academic_year_id = ?
  `, [log_id, academic_year_id]);

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
    ORDER BY uploaded_at DESC
  `, [log_id]);

    log.attachments = attachments;

    return log;
  }

  // =========================
  // GET ATTACHMENT BY ID
  // =========================
  static async getAttachmentById(attachmentId, academic_year_id) {

    const [[file]] = await db.query(`
    SELECT
      a.*,
      l.student_id,
      s.department_id
    FROM attachments a
    JOIN daily_logs l
      ON l.log_id = a.log_id
    JOIN students s
      ON s.student_id = l.student_id
    WHERE a.attachment_id = ?
    AND l.academic_year_id = ?
  `, [attachmentId, academic_year_id]);

    return file || null;
  }

  // =========================
  // COORDINATOR / ADMIN LOGS
  // =========================
  static async getByDepartment(department_id, academic_year_id) {

    const query = `
      SELECT 
        l.*,

        u.f_name,
        u.l_name,
        CONCAT(u.f_name,' ',u.l_name) AS student_name,
        u.photo,

        cr.course_code AS course,

        s.student_id,

        a.time_in,
        a.lunch_break_start,
        a.lunch_break_end,
        a.time_out,
        a.ot_time_in,
        a.ot_time_out,

        ROUND(
          (
            (
              IFNULL(
                TIME_TO_SEC(TIMEDIFF(a.time_out, a.time_in)),
                0
              )

              - IF(
                  a.lunch_break_start IS NOT NULL
                  AND a.lunch_break_end IS NOT NULL,

                  TIME_TO_SEC(
                    TIMEDIFF(
                      a.lunch_break_end,
                      a.lunch_break_start
                    )
                  ),

                  IF(
                    IFNULL(
                      TIME_TO_SEC(TIMEDIFF(a.time_out, a.time_in)),
                      0
                    ) >= 18000,
                    3600,
                    0
                  )
                )
            )

            + IFNULL(
                TIME_TO_SEC(
                  TIMEDIFF(a.ot_time_out, a.ot_time_in)
                ),
                0
              )
          ) / 3600,
          2
        ) AS total_hours,

        (
          SELECT COUNT(*)
          FROM attachments att
          WHERE att.log_id = l.log_id
        ) AS attachment_count

      FROM daily_logs l

      JOIN students s ON s.student_id = l.student_id
      JOIN users u ON u.user_id = s.user_id

      LEFT JOIN courses cr ON cr.course_id = s.course_id

      LEFT JOIN attendance a
        ON l.student_id = a.student_id
        AND l.log_date = a.attendance_date
    `;

    if (department_id !== null) {

      const [rows] = await db.query(
        query + `
          WHERE s.department_id = ?
          AND l.academic_year_id = ?
          ORDER BY l.log_date DESC
        `,
        [department_id, academic_year_id]
      );

      return rows;
    }

    const [rows] = await db.query(
      query + `
    WHERE l.academic_year_id = ?
    ORDER BY l.log_date DESC
  `,
      [academic_year_id]
    );

    return rows;
  }
  // =========================
  // ADD ATTACHMENT
  // =========================
  static async addAttachment(data) {

    const {
      log_id,
      file_name,
      file_path,
      file_type
    } = data;

    await db.query(`
      INSERT INTO attachments
      (
        log_id,
        file_name,
        file_path,
        file_type
      )
      VALUES (?, ?, ?, ?)
    `, [
      log_id,
      file_name,
      file_path,
      file_type
    ]);

  }

  // =========================
  // UPDATE LOG (student revision)
  // =========================
  static async updateByStudent(
    log_id,
    student_id,
    academic_year_id,
    data
  ) {

    const { narrative } = data;

    const [result] = await db.query(`
      UPDATE daily_logs
      SET
        narrative = ?,
        status = 'submitted'
      WHERE log_id = ?
      AND student_id = ?
      AND academic_year_id = ?
    `, [
      narrative,
      log_id,
      student_id,
      academic_year_id
    ]);

    const [[coord]] = await db.query(`
      SELECT co.user_id
      FROM students s
      JOIN courses c
        ON s.course_id = c.course_id
      JOIN coordinators co
        ON co.department_id = c.department_id
      WHERE s.student_id = ?
      LIMIT 1
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
  // UPDATE STATUS (coordinator)
  // =========================
  static async updateStatus(
    log_id,
    status,
    remarks,
    academic_year_id
  ) {

    await db.query(`
      UPDATE daily_logs
      SET
        status = ?,
        feedback = ?
      WHERE log_id = ?
      AND academic_year_id = ?
    `, [
      status,
      remarks,
      log_id,
      academic_year_id
    ]);

    const [[row]] = await db.query(`
      SELECT
        s.user_id,
        l.log_date
      FROM daily_logs l
      JOIN students s
        ON l.student_id = s.student_id
      WHERE l.log_id = ?
      AND l.academic_year_id = ?
    `, [
      log_id,
      academic_year_id
    ]);

    if (!row?.user_id) return;

    let title;
    let message;

    if (status === "approved") {

      title = "Daily Log Approved";
      message = "Your daily OJT log has been approved.";

    } else if (status === "revision") {

      title = "Coordinator Feedback";
      message =
        "Your daily log has feedback and needs revision.";

    } else {

      title = "Daily Log Updated";
      message =
        "Your daily log status changed.";

    }

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

    if (status === "revision") {

      await db.query(`
        INSERT INTO messages
        (
          sender_id,
          receiver_id,
          message,
          message_type,
          related_log_id
        )
        VALUES (?, ?, ?, 'system', ?)
      `, [
        null,
        row.user_id,
        `Coordinator commented on your Daily Log (${row.log_date})`,
        log_id
      ]);

    }

  }

}

module.exports = LogModel;