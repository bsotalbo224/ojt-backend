const db = require("../config/db");
const bcrypt = require("bcrypt");
const { generatePassword } = require("../utils/password");
const { sendStudentCredentials } = require("../utils/mailer");
const { sendNotification } = require("../services/notificationServices");

class StudentModel {

  // =========================
  // ALL STUDENTS (admin)
  // =========================
  static async getAll() {
    const [rows] = await db.query(`
      SELECT 
        s.student_id,
        s.course_id,
        u.f_name,
        u.l_name,
        u.email,
        c.course_code,
        c.course_name,
        comp.company_name,
        s.ojt_hours_required,
        s.is_active
      FROM students s
      JOIN users u ON s.user_id = u.user_id
      LEFT JOIN courses c ON s.course_id = c.course_id
      LEFT JOIN companies comp ON s.company_id = comp.company_id
      ORDER BY u.l_name ASC
    `);

    return rows;
  }

  // =========================
  // CREATE STUDENT (admin)
  // =========================
  static async create(data) {
    const {
      f_name,
      l_name,
      email,
      course_id,
      course,
      company_id,
      ojt_hours_required,
      totalHours
    } = data;

    const finalCourseId = course_id || course || null;
    const finalHours = ojt_hours_required || totalHours || 0;

    const conn = await db.getConnection();

    try {
      await conn.beginTransaction();

      const plainPassword = generatePassword(8);
      const hashedPassword = await bcrypt.hash(plainPassword, 10);

      // create user
      const [userRes] = await conn.query(
        `INSERT INTO users (f_name, l_name, email, password, role)
         VALUES (?, ?, ?, ?, 'student')`,
        [f_name, l_name, email, hashedPassword]
      );

      const user_id = userRes.insertId;

      // create student
      const [studentRes] = await conn.query(
        `INSERT INTO students (
          user_id,
          course_id,
          department_id,
          company_id,
          ojt_hours_required
        )
        VALUES (
          ?, 
          ?, 
          (SELECT department_id FROM courses WHERE course_id = ?),
          ?, 
          ?
        )`,
        [user_id, finalCourseId, finalCourseId, company_id || null, finalHours]
      );

      await conn.commit();

      // system notification
      await sendNotification({
        user_id,
        title: "OJT Account Created",
        message: `Welcome ${f_name}! Your OJT account is ready.`,
        type: "system",
        link: "/student/dashboard"
      });

      // email credentials
      await sendStudentCredentials(
        email,
        plainPassword,
        `${f_name} ${l_name}`
      );

      return studentRes.insertId;

    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  // =========================
  // UPDATE STUDENT (admin)
  // =========================
  static async update(student_id, data) {
    const { f_name, l_name, email, course_id, ojt_hours_required } = data;

    await db.query(
      `UPDATE users u
       JOIN students s ON s.user_id = u.user_id
       SET u.f_name = ?, u.l_name = ?, u.email = ?
       WHERE s.student_id = ?`,
      [f_name, l_name, email, student_id]
    );

    await db.query(
      `UPDATE students
   SET 
     course_id = ?,
     department_id = (
       SELECT department_id
       FROM courses
       WHERE course_id = ?
     ),
     ojt_hours_required = ?
   WHERE student_id = ?`,
      [course_id, course_id, ojt_hours_required, student_id]
    );

    const [[row]] = await db.query(`
      SELECT 
        s.student_id,
        u.f_name,
        u.l_name,
        u.email,
        c.course_id,
        c.course_code,
        c.course_name,
        s.ojt_hours_required,
        s.is_active
      FROM students s
      JOIN users u ON s.user_id = u.user_id
      LEFT JOIN courses c ON s.course_id = c.course_id
      WHERE s.student_id = ?
    `, [student_id]);

    return row;
  }

  // =========================
  // SET STATUS (admin)
  // =========================
  static async setStatus(student_id, is_active) {
    await db.query(
      `UPDATE students
   SET 
     is_active = ?,
     inactive_since = IF(? = 0, NOW(), NULL)
   WHERE student_id = ?`,
      [is_active, is_active, student_id]
    );

    // NOTE:
    // We intentionally removed activation/deactivation notification
    // because inactive users cannot log in to see it.
    // If needed, send EMAIL instead (better UX).

    const [[row]] = await db.query(`
      SELECT 
        s.student_id,
        s.course_id,
        u.f_name,
        u.l_name,
        u.email,
        c.course_code,
        c.course_name,
        s.ojt_hours_required,
        s.is_active
      FROM students s
      JOIN users u ON s.user_id = u.user_id
      LEFT JOIN courses c ON s.course_id = c.course_id
      WHERE s.student_id = ?
    `, [student_id]);

    return row;
  }

  // =========================
  // STUDENTS BY COORDINATOR
  // =========================
  static async getByCoordinator(user_id) {
    const [rows] = await db.query(`
      SELECT 
        s.student_id,
        s.course_id,
        u.f_name,
        u.l_name,
        u.email,
        c.course_code,
        c.course_name,
        d.department_name,
        comp.company_name,
        s.ojt_hours_required,
        s.is_active
      FROM students s
      JOIN users u ON s.user_id = u.user_id
      LEFT JOIN courses c ON s.course_id = c.course_id
      LEFT JOIN departments d ON c.department_id = d.department_id
      LEFT JOIN companies comp ON s.company_id = comp.company_id
      JOIN coordinators co ON co.department_id = c.department_id
      WHERE co.user_id = ?
      ORDER BY u.l_name ASC
    `, [user_id]);

    return rows;
  }

// =========================
// STUDENT PROGRESS (coordinator)
// =========================
static async getStudentProgress(student_id) {

  // Student basic info
  const [[student]] = await db.query(`
    SELECT 
  s.student_id,

  s.ojt_hours_required,

  s.start_time,
  s.end_time,

  u.f_name,
  u.l_name,

  c.course_code AS course,

  comp.company_name AS company

    FROM students s

    JOIN users u
      ON s.user_id = u.user_id

    LEFT JOIN courses c
      ON s.course_id = c.course_id

    LEFT JOIN companies comp
      ON s.company_id = comp.company_id

    WHERE s.student_id = ?
  `, [student_id]);

  // =========================
  // ATTENDANCE SUMMARY
  // VERIFIED ONLY COUNTS
  // =========================
  const [[summary]] = await db.query(`
    SELECT

      COUNT(DISTINCT attendance_date)
        AS attendanceRecords,

      COUNT(DISTINCT attendance_date)
        AS attendanceDays,

      MAX(attendance_date)
        AS lastAttendance,

      ROUND(
        IFNULL(
          SUM(
            CASE

              WHEN location_status = 'verified'

              THEN (

                (
                  IFNULL(
                    TIME_TO_SEC(
                      TIMEDIFF(
                        time_out,
                        time_in
                      )
                    ),
                    0
                  )

                  - IF(
                      lunch_break_start IS NOT NULL
                      AND lunch_break_end IS NOT NULL,

                      TIME_TO_SEC(
                        TIMEDIFF(
                          lunch_break_end,
                          lunch_break_start
                        )
                      ),

                      IF(
                        IFNULL(
                          TIME_TO_SEC(
                            TIMEDIFF(
                              time_out,
                              time_in
                            )
                          ),
                          0
                        ) >= 18000,
                        3600,
                        0
                      )
                    )
                )

                + IFNULL(
                    TIME_TO_SEC(
                      TIMEDIFF(
                        ot_time_out,
                        ot_time_in
                      )
                    ),
                    0
                  )
              )

              ELSE 0

            END
          ),
          0
        ) / 3600,
        2
      ) AS hoursCompleted

    FROM attendance

    WHERE student_id = ?
  `, [student_id]);

  // =========================
  // RECENT ATTENDANCE
  // KEEP FLAGGED VISIBLE
  // =========================
  const [recentAttendance] = await db.query(`
    SELECT

      attendance_id,

      attendance_date AS date,

      time_in,
      lunch_break_start,
      lunch_break_end,
      time_out,

      ot_time_in,
      ot_time_out,

      location_status,

      ROUND(
        (
          (
            IFNULL(
              TIME_TO_SEC(
                TIMEDIFF(
                  time_out,
                  time_in
                )
              ),
              0
            )

            - IF(
                lunch_break_start IS NOT NULL
                AND lunch_break_end IS NOT NULL,

                TIME_TO_SEC(
                  TIMEDIFF(
                    lunch_break_end,
                    lunch_break_start
                  )
                ),

                IF(
                  IFNULL(
                    TIME_TO_SEC(
                      TIMEDIFF(
                        time_out,
                        time_in
                      )
                    ),
                    0
                  ) >= 18000,
                  3600,
                  0
                )
              )
          )

          + IFNULL(
              TIME_TO_SEC(
                TIMEDIFF(
                  ot_time_out,
                  ot_time_in
                )
              ),
              0
            )
        ) / 3600,
        2
      ) AS hours

    FROM attendance

    WHERE student_id = ?

    ORDER BY
      attendance_date DESC,
      attendance_id DESC

    LIMIT 5
  `, [student_id]);

  return {
    student,

    attendanceDays:
      summary.attendanceDays || 0,

    attendanceRecords:
      summary.attendanceRecords || 0,

    lastAttendance:
      summary.lastAttendance,

    hoursCompleted:
      summary.hoursCompleted || 0,

    recentAttendance
  };
}
}

module.exports = StudentModel;