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
        AND time_out IS NOT NULL
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

      s.department_id,
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
      ) AS total_hours

    FROM daily_logs l

    JOIN students s
      ON s.student_id = l.student_id

    LEFT JOIN attendance a
      ON l.student_id = a.student_id
      AND l.log_date = a.attendance_date

    WHERE l.log_id = ?
  `, [log_id]);

  return log || null;
}

  // =========================
  // COORDINATOR / ADMIN LOGS
  // =========================
  static async getByDepartment(department_id) {

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
          ORDER BY l.log_date DESC
        `,
        [department_id]
      );

      return rows;
    }

    const [rows] = await db.query(
      query + `
        ORDER BY l.log_date DESC
      `
    );

    return rows;
  }

}

module.exports = LogModel;