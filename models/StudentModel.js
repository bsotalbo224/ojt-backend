const db = require("../config/db");
const bcrypt = require("bcrypt");
const { generatePassword } = require("../utils/password");
const { sendStudentCredentials } = require("../utils/mailer");
const { sendNotification } = require("../services/notificationServices");
const AcademicYearModel = require("./AcademicYearModel");
const MessageModel = require("./messageModel");

class StudentModel {

  static async getAll(academic_year_id) {
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
      WHERE s.academic_year_id = ?
      ORDER BY u.l_name ASC
    `, [academic_year_id]);

    return rows;
  }

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

    let user_id;
    let studentRes;
    let activeYear;
    let plainPassword;

    try {
      await conn.beginTransaction();

      plainPassword = generatePassword(8);
      const hashedPassword = await bcrypt.hash(plainPassword, 10);

      const [userRes] = await conn.query(
        `INSERT INTO users (f_name, l_name, email, password, role)
         VALUES (?, ?, ?, ?, 'student')`,
        [f_name, l_name, email, hashedPassword]
      );

      user_id = userRes.insertId;

      activeYear = await AcademicYearModel.getActive(conn);

      if (!activeYear) {
        throw new Error("No active academic year found");
      }

      // Resolve the department up front so it can be used both in the
      // INSERT below and in syncDepartmentConversation(), avoiding a
      // second lookup after the student row exists.
      const [[courseRow]] = await conn.query(
        `SELECT department_id FROM courses WHERE course_id = ?`,
        [finalCourseId]
      );

      if (!courseRow || !courseRow.department_id) {
        throw new Error("Selected course does not have an associated department");
      }

      const departmentId = courseRow.department_id;

      [studentRes] = await conn.query(
        `INSERT INTO students (
            user_id,
            course_id,
            department_id,
            company_id,
            ojt_hours_required,
            academic_year_id
          )
          VALUES (?, ?, ?, ?, ?, ?)`,
        [user_id, finalCourseId, departmentId, company_id || null, finalHours, activeYear.academic_year_id]
      );

      // Keep the department consultation group in sync with the newly
      // created student, inside the same transaction as the insert above.
      await MessageModel.syncDepartmentConversation(
        conn,
        departmentId,
        activeYear.academic_year_id,
        user_id
      );

      await conn.commit();

    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }

    sendNotification({
      user_id,
      title: "OJT Account Created",
      message: `Welcome ${f_name}! Your OJT account is ready.`,
      type: "system",
      link: "/student/dashboard",
      academic_year_id: activeYear.academic_year_id
    }).catch((err) => {
      console.error("NOTIFICATION ERROR:", err);
    });

    sendStudentCredentials(
      email,
      plainPassword,
      `${f_name} ${l_name}`
    ).catch((err) => {
      console.error("EMAIL ERROR:", err);
    });

    return studentRes.insertId;
  }

  static async update(student_id, data) {
    const conn = await db.getConnection();

    let row;

    try {
      await conn.beginTransaction();

      const [[existing]] = await conn.query(
        `SELECT u.f_name, u.l_name, u.email, s.course_id, s.ojt_hours_required,
                s.department_id, s.academic_year_id
         FROM students s
         JOIN users u ON s.user_id = u.user_id
         WHERE s.student_id = ?`,
        [student_id]
      );

      if (!existing) {
        const err = new Error("Student not found");
        err.statusCode = 404;
        throw err;
      }

      const {
        f_name,
        l_name,
        email,
        course_id,
        course,
        ojt_hours_required,
        totalHours
      } = data;

      const finalCourseId = course_id || course || existing.course_id;
      const finalHours = ojt_hours_required || totalHours || existing.ojt_hours_required;
      const finalFName = f_name ?? existing.f_name;
      const finalLName = l_name ?? existing.l_name;
      const finalEmail = email ?? existing.email;

      // Captured before the update so we can detect a department transfer
      // and synchronize both the old and new department groups below.
      const oldDepartmentId = existing.department_id;
      const academicYearId = existing.academic_year_id;

      await conn.query(
        `UPDATE users u
         JOIN students s ON s.user_id = u.user_id
         SET u.f_name = ?, u.l_name = ?, u.email = ?
         WHERE s.student_id = ?`,
        [finalFName, finalLName, finalEmail, student_id]
      );

      await conn.query(
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
        [finalCourseId, finalCourseId, finalHours, student_id]
      );

      const [[updatedStudent]] = await conn.query(
        `SELECT department_id FROM students WHERE student_id = ?`,
        [student_id]
      );

      const newDepartmentId = updatedStudent.department_id;

      // Only re-sync when the student actually moved departments. A
      // transfer means the old group must lose them and the new group
      // must gain them.
      if (oldDepartmentId !== newDepartmentId) {
        await MessageModel.syncDepartmentConversation(conn, oldDepartmentId, academicYearId);
        await MessageModel.syncDepartmentConversation(conn, newDepartmentId, academicYearId);
      }

      [[row]] = await conn.query(`
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

      await conn.commit();

    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }

    return row;
  }

  static async setStatus(student_id, is_active) {
    const conn = await db.getConnection();

    let row;

    try {
      await conn.beginTransaction();

      await conn.query(
        `UPDATE students
         SET 
           is_active = ?,
           inactive_since = IF(? = 0, NOW(), NULL)
         WHERE student_id = ?`,
        [is_active, is_active, student_id]
      );

      const [[student]] = await conn.query(
        `SELECT department_id, academic_year_id FROM students WHERE student_id = ?`,
        [student_id]
      );

      // Re-syncing removes the student from the group when deactivated
      // and restores them when reactivated.
      if (student) {
        await MessageModel.syncDepartmentConversation(
          conn,
          student.department_id,
          student.academic_year_id
        );
      }

      [[row]] = await conn.query(`
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

      await conn.commit();

    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }

    return row;
  }

  static async getByCoordinator(user_id, academic_year_id) {
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
        AND s.academic_year_id = ?
      ORDER BY u.l_name ASC
    `, [user_id, academic_year_id]);

    return rows;
  }

  static async getStudentProgress(student_id, academic_year_id = null) {
    const safeStudentId = student_id ?? null;

    const [[student]] = await db.query(`
      SELECT 
        s.student_id,
        s.academic_year_id,
        s.ojt_hours_required,
        s.start_time,
        s.end_time,
        u.f_name,
        u.l_name,
        c.course_code AS course,
        comp.company_name AS company
      FROM students s
      JOIN users u ON s.user_id = u.user_id
      LEFT JOIN courses c ON s.course_id = c.course_id
      LEFT JOIN companies comp ON s.company_id = comp.company_id
      WHERE s.student_id = ?
        AND (? IS NULL OR s.academic_year_id = ?)
    `, [safeStudentId, academic_year_id, academic_year_id]);

    const effectiveYearId = academic_year_id ?? (student ? student.academic_year_id : null);

    const effectiveStartExpr = `
      CASE
        WHEN a.is_early = 1 AND a.early_status = 'approved'
          THEN a.time_in
        WHEN a.is_early = 1
          THEN IFNULL(s.start_time, a.time_in)
        ELSE a.time_in
      END
    `;

    const workedSecondsExpr = `
      IFNULL(
        TIME_TO_SEC(
          TIMEDIFF(
            a.time_out,
            ${effectiveStartExpr}
          )
        ),
        0
      )
    `;

    const lunchDeductionExpr = `
      IF(
        a.lunch_break_start IS NOT NULL
        AND a.lunch_break_end IS NOT NULL,
        TIME_TO_SEC(
          TIMEDIFF(
            a.lunch_break_end,
            a.lunch_break_start
          )
        ),
        IF(
          ${workedSecondsExpr} >= 18000,
          3600,
          0
        )
      )
    `;

    const otSecondsExpr = `
      IFNULL(
        TIME_TO_SEC(
          TIMEDIFF(
            a.ot_time_out,
            a.ot_time_in
          )
        ),
        0
      )
    `;

    const totalSecondsExpr = `
      GREATEST(
        0,
        (
          ${workedSecondsExpr}
          - ${lunchDeductionExpr}
          + ${otSecondsExpr}
        )
      )
    `;

    const [[summary]] = await db.query(`
      SELECT
        COUNT(CASE WHEN a.location_status != 'flagged' THEN a.attendance_id END) AS attendanceRecords,
        COUNT(DISTINCT CASE WHEN a.location_status != 'flagged' THEN a.attendance_date END) AS attendanceDays,
        MAX(CASE WHEN a.location_status != 'flagged' THEN a.attendance_date END) AS lastAttendance,
        ROUND(
          IFNULL(
            SUM(
              CASE
                WHEN a.location_status = 'verified'
                THEN ${totalSecondsExpr}
                ELSE 0
              END
            ),
            0
          ) / 3600,
          2
        ) AS hoursCompleted
      FROM attendance a
      LEFT JOIN students s ON s.student_id = a.student_id
      WHERE a.student_id = ?
        AND (? IS NULL OR a.academic_year_id = ?)
    `, [safeStudentId, effectiveYearId, effectiveYearId]);

    const [recentAttendance] = await db.query(`
      SELECT
        a.attendance_id,
        a.attendance_date AS date,
        a.time_in,
        CASE WHEN a.is_early = 1 THEN a.time_in ELSE NULL END AS actual_time_in,
        a.lunch_break_start,
        a.lunch_break_end,
        a.time_out,
        a.ot_time_in,
        a.ot_time_out,
        a.location_status,
        a.is_early,
        a.early_status,
        CASE
          WHEN a.is_early = 1 AND a.time_in IS NOT NULL AND s.start_time IS NOT NULL
            THEN GREATEST(
              0,
              ROUND(TIME_TO_SEC(TIMEDIFF(s.start_time, a.time_in)) / 60)
            )
          ELSE NULL
        END AS early_minutes,
        s.start_time,
        s.end_time,
        CASE
          WHEN a.location_status = 'flagged' THEN 0
          ELSE ROUND(${totalSecondsExpr} / 3600, 2)
        END AS hours
      FROM attendance a
      LEFT JOIN students s ON s.student_id = a.student_id
      WHERE a.student_id = ?
        AND (? IS NULL OR a.academic_year_id = ?)
      ORDER BY
        a.attendance_date DESC,
        a.attendance_id DESC
      LIMIT 5
    `, [safeStudentId, effectiveYearId, effectiveYearId]);

    return {
      student,
      attendanceDays: summary.attendanceDays || 0,
      attendanceRecords: summary.attendanceRecords || 0,
      lastAttendance: summary.lastAttendance,
      hoursCompleted: summary.hoursCompleted || 0,
      recentAttendance
    };
  }
}

module.exports = StudentModel;