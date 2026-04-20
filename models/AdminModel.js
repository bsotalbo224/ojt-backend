  const db = require("../config/db");

  class AdminModel {

  /* ===================================================
  DASHBOARD STATS
  =================================================== */
  static async getStats() {
    const [[students]] = await db.query(
      "SELECT COUNT(*) AS total FROM students"
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

  /* ===================================================
  ADMIN STUDENTS OVERVIEW
  =================================================== */
  static async getStudentsOverview() {
    const [rows] = await db.query(`
      SELECT
        s.student_id,
        u.f_name,
        u.l_name,
        u.photo,
        c.course_code,
        c.course_name,
        comp.company_name,

        CONCAT(cu.f_name, ' ', cu.l_name) AS coordinator,

        COALESCE(s.ojt_hours_required, c.required_hours) AS totalHours,

        IFNULL(
          SUM(TIME_TO_SEC(TIMEDIFF(a.time_out, a.time_in)) / 3600),
          0
        ) AS hoursCompleted

      FROM students s
      JOIN users u ON s.user_id = u.user_id
      LEFT JOIN courses c ON s.course_id = c.course_id
      LEFT JOIN companies comp ON s.company_id = comp.company_id

      LEFT JOIN coordinators coord ON s.department_id = coord.department_id
      LEFT JOIN users cu ON coord.user_id = cu.user_id

      LEFT JOIN attendance a ON s.student_id = a.student_id
        AND a.time_out IS NOT NULL

      GROUP BY
        s.student_id,
        u.f_name,
        u.l_name,
        c.course_code,
        c.course_name,
        comp.company_name,
        cu.f_name,
        cu.l_name,
        s.ojt_hours_required

      ORDER BY u.l_name ASC
      LIMIT 4
    `);

    return rows;
  }

  /* ===================================================
  ADMIN COORDINATORS LIST
  =================================================== */
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
      JOIN users u ON c.user_id = u.user_id
      LEFT JOIN students s ON s.department_id = c.department_id

      GROUP BY
        c.coordinator_id,
        u.f_name,
        u.l_name,
        u.email,
        c.department_id,
        c.is_active

      ORDER BY u.l_name ASC
    `);

    return rows;
  }
  /* ===================================================
  ADMIN RECENT ACTIVITY
  =================================================== */
  static async getRecentActivity() {
    const [rows] = await db.query(`
      SELECT
        notif_id,
        message,
        type,
        created_at
      FROM notifications
      WHERE type IN ('log', 'narrative',  'evaluation', 'coordinator')
      ORDER BY created_at DESC
      LIMIT 4
    `);

    return rows;
  }

  /* ===================================================
  ARCHIVED STUDENTS
  =================================================== */
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
      JOIN users u ON sa.user_id = u.user_id
      LEFT JOIN courses c ON sa.course_id = c.course_id
      ORDER BY sa.archived_at DESC
    `);

    return rows;
  }

  /* ===================================================
  RESTORE ARCHIVED STUDENT
  =================================================== */
  static async restoreStudent(student_id) {

    const conn = await db.getConnection();

    try {
      await conn.beginTransaction();

      const [[student]] = await conn.query(`
        SELECT *
        FROM students_archive
        WHERE student_id = ?
      `, [student_id]);

      if (!student) throw new Error("Student not found");

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
          course_id
        )
        VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
      `, [
        student.student_id,
        student.user_id,
        student.section,
        student.ojt_hours_required,
        student.location_id,
        student.company_id,
        student.department_id,
        student.course_id
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
