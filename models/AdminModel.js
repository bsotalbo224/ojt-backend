const db = require("../config/db");

class AdminModel {

  // =========================
  // DASHBOARD STATS
  // =========================
  static async getStats(academic_year_id) {

    const [[students]] = await db.query(
      `SELECT COUNT(*) AS total
       FROM students
       WHERE academic_year_id = ?`,
      [academic_year_id]
    );

    const [[companies]] = await db.query(
      "SELECT COUNT(*) AS total FROM companies"
    );

    const [[coordinators]] = await db.query(
      "SELECT COUNT(*) AS total FROM coordinators"
    );

    return {
      totalStudents: students.total,
      totalCompanies: companies.total,
      totalCoordinators: coordinators.total,
    };
  }

  // =========================
  // STUDENTS OVERVIEW (FIXED HOURS)
  // =========================
  static async getStudentsOverview(academic_year_id) {

    const [rows] = await db.query(`
      SELECT
        s.student_id,

        MAX(u.f_name) AS f_name,
        MAX(u.l_name) AS l_name,
        MAX(u.photo) AS photo,

        MAX(c.course_code) AS course_code,
        MAX(c.course_name) AS course_name,

        MAX(comp.company_name) AS company_name,

        MAX(CONCAT(cu.f_name, ' ', cu.l_name)) AS coordinator,

        MAX(COALESCE(s.ojt_hours_required, c.required_hours)) AS totalHours,

        IFNULL(
          SUM(
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
            ) / 3600
          ),
          0
        ) AS hoursCompleted

      FROM students s
      JOIN users u
        ON s.user_id = u.user_id

      LEFT JOIN courses c
        ON s.course_id = c.course_id

      LEFT JOIN companies comp
        ON s.company_id = comp.company_id

      LEFT JOIN coordinators coord
        ON s.department_id = coord.department_id

      LEFT JOIN users cu
        ON coord.user_id = cu.user_id

      LEFT JOIN attendance a
        ON s.student_id = a.student_id
        AND a.academic_year_id = ?

      WHERE s.academic_year_id = ?

      GROUP BY s.student_id

      ORDER BY MAX(u.l_name) ASC

      LIMIT 4
    `, [academic_year_id]);

    return rows;
  }

  // =========================
  // COORDINATORS LIST
  // =========================
  static async getCoordinators() {

    const [rows] = await db.query(`
      SELECT
        c.coordinator_id,
        u.f_name,
        u.l_name,
        u.email,
        c.department_id,
        c.is_active,
        COUNT(s.student_id) AS assignedStudents

      FROM coordinators c

      JOIN users u
        ON c.user_id = u.user_id

      LEFT JOIN students s
        ON s.department_id = c.department_id

      GROUP BY c.coordinator_id

      ORDER BY u.l_name ASC
    `);

    return rows;
  }

  // =========================
  // RECENT ACTIVITY
  // =========================
  static async getRecentActivity() {

    const [rows] = await db.query(`
      SELECT
        notif_id,
        message,
        type,
        created_at

      FROM notifications

      WHERE type IN (
        'log',
        'narrative',
        'evaluation',
        'coordinator'
      )

      ORDER BY created_at DESC

      LIMIT 4
    `);

    return rows;
  }

  // =========================
  // ARCHIVED STUDENTS
  // =========================
  static async getArchivedStudents() {

    const [rows] = await db.query(`
      SELECT
        sa.student_id,
        u.f_name,
        u.l_name,
        u.email,
        c.course_name,
        sa.archived_at

      FROM students_archive sa

      JOIN users u
        ON sa.user_id = u.user_id

      LEFT JOIN courses c
        ON sa.course_id = c.course_id

      ORDER BY sa.archived_at DESC
    `);

    return rows;
  }

  // =========================
  // RESTORE STUDENT
  // =========================
  static async restoreStudent(student_id) {

    const conn = await db.getConnection();

    try {

      await conn.beginTransaction();

      const [[student]] = await conn.query(`
        SELECT *
        FROM students_archive
        WHERE student_id = ?
      `, [student_id]);

      if (!student) {
        throw new Error("Student not found");
      }

      await conn.query(`
        INSERT INTO students (
          student_id,
          user_id,
          section,
          ojt_hours_required,
          location_id,
          company_id,
          is_active,
          department_id,
          course_id,
          start_time,
          end_time,
          academic_year_id
        )
        VALUES (
          ?, ?, ?, ?, ?, ?, 1,
          ?, ?, ?, ?, ?
        )
      `, [
        student.student_id,
        student.user_id,
        student.section,
        student.ojt_hours_required,
        student.location_id,
        student.company_id,
        student.department_id,
        student.course_id,
        student.start_time,
        student.end_time,
        student.academic_year_id
      ]);

      await conn.query(`
        DELETE FROM students_archive
        WHERE student_id = ?
      `, [student_id]);

      await conn.commit();

    } catch (err) {

      await conn.rollback();
      throw err;

    } finally {

      conn.release();

    }
  }
}

module.exports = AdminModel;