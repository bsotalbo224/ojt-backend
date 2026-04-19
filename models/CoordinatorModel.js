const db = require("../config/db");
const bcrypt = require("bcryptjs");
const { generatePassword } = require("../utils/password");
const { sendCoordinatorCredentials } = require("../utils/mailer");
const { sendNotification } = require("../services/notificationServices");

class CoordinatorModel {

  // =========================
  // GET ALL (admin)
  // =========================
  static async getAll() {
    const [rows] = await db.query(`
      SELECT 
        c.coordinator_id,
        u.f_name,
        u.l_name,
        u.email,
        c.department_id,
        d.department_code,
        d.department_name,
        c.is_active
      FROM coordinators c
      JOIN users u ON c.user_id = u.user_id
      LEFT JOIN departments d ON c.department_id = d.department_id
      ORDER BY u.l_name ASC
    `);

    return rows;
  }

  // =========================
  // CREATE COORDINATOR (admin)
  // =========================
  static async create(data) {
    const { f_name, l_name, email, department_id } = data;

    const conn = await db.getConnection();

    try {
      await conn.beginTransaction();

      const plainPassword = generatePassword(8);
      const hashedPassword = await bcrypt.hash(plainPassword, 10);

      const [userRes] = await conn.query(
        `INSERT INTO users (f_name, l_name, email, password, role)
         VALUES (?, ?, ?, ?, 'coordinator')`,
        [f_name, l_name, email, hashedPassword]
      );

      const user_id = userRes.insertId;

      const [coordRes] = await conn.query(
        `INSERT INTO coordinators (user_id, department_id)
   VALUES (?, ?)`,
        [user_id, department_id]
      );

      // also make this user an admin automatically
      await conn.query(
        `INSERT INTO admins (user_id)
   VALUES (?)`,
        [user_id]
      );

      await conn.commit();

      await sendNotification({
        user_id,
        title: "Coordinator Account Created",
        message: "Your coordinator account has been created.",
        type: "system",
        link: "/dashboard-select"
      });

      await sendCoordinatorCredentials(
        email,
        plainPassword,
        `${f_name} ${l_name}`
      );

      return coordRes.insertId;

    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  // =========================
  // UPDATE COORDINATOR (admin)
  // =========================
  static async update(coordinator_id, data) {
    const { f_name, l_name, email, department_id } = data;

    // update user
    await db.query(
      `UPDATE users u
       JOIN coordinators c ON c.user_id = u.user_id
       SET u.f_name = ?, u.l_name = ?, u.email = ?
       WHERE c.coordinator_id = ?`,
      [f_name, l_name, email, coordinator_id]
    );

    // update coordinator
    await db.query(
      `UPDATE coordinators
       SET department_id = ?
       WHERE coordinator_id = ?`,
      [department_id, coordinator_id]
    );

    // return updated joined row
    const [[row]] = await db.query(`
      SELECT 
        c.coordinator_id,
        u.f_name,
        u.l_name,
        u.email,
        c.department_id,
        d.department_code,
        d.department_name,
        c.is_active
      FROM coordinators c
      JOIN users u ON c.user_id = u.user_id
      LEFT JOIN departments d ON c.department_id = d.department_id
      WHERE c.coordinator_id = ?
    `, [coordinator_id]);

    return row;
  }

  // =========================
  // TOGGLE STATUS (admin)
  // =========================
  static async setStatus(coordinator_id, is_active) {

    await db.query(
      `UPDATE coordinators
       SET is_active = ?
       WHERE coordinator_id = ?`,
      [is_active, coordinator_id]
    );

    const [[row]] = await db.query(`
      SELECT 
        c.coordinator_id,
        u.f_name,
        u.l_name,
        u.email,
        c.department_id,
        d.department_code,
        d.department_name,
        c.is_active
      FROM coordinators c
      JOIN users u ON c.user_id = u.user_id
      LEFT JOIN departments d ON c.department_id = d.department_id
      WHERE c.coordinator_id = ?
    `, [coordinator_id]);

    return row;
  }

  // =========================
  // DASHBOARD STATS (coordinator)
  // =========================
  static async getDashboardStats(coordinatorUserId) {
    // coordinator department
    const [[coord]] = await db.query(`
      SELECT department_id
      FROM coordinators
      WHERE user_id = ?
    `, [coordinatorUserId]);

    if (!coord) return null;

    const deptId = coord.department_id;

    // total students in dept
    const [[students]] = await db.query(`
      SELECT COUNT(*) AS totalStudents
      FROM students
      WHERE department_id = ?
    `, [deptId]);

    // ongoing OJT (assigned company)
    const [[ongoing]] = await db.query(`
      SELECT COUNT(*) AS ongoing
      FROM students
      WHERE department_id = ?
      AND company_id IS NOT NULL
    `, [deptId]);

    // pending daily logs
    const [[submittedLogs]] = await db.query(`
      SELECT COUNT(*) AS submittedLogs
      FROM daily_logs dl
      JOIN students s ON s.student_id = dl.student_id
      WHERE s.department_id = ?
      AND dl.status = 'submitted'
    `, [deptId]);

    // pending narratives
    const [[submittedNarratives]] = await db.query(`
      SELECT COUNT(*) AS submittedNarratives
      FROM narrative_reports n
      JOIN students s ON s.student_id = n.student_id
      WHERE s.department_id = ?
      AND n.status = 'submitted'
    `, [deptId]);

    // ===============================
// FLAGGED ATTENDANCE
// ===============================
const [[flaggedAttendance]] = await db.query(`
  SELECT COUNT(*) AS flaggedAttendance
  FROM attendance a
  JOIN students s ON s.student_id = a.student_id
  WHERE s.department_id = ?
  AND a.location_status = 'flagged'
`, [deptId]);

// ===============================
// RETURN (AFTER ALL QUERIES)
// ===============================
return {
  totalStudents: students.totalStudents,
  ongoing: ongoing.ongoing,
  submittedLogs: submittedLogs.submittedLogs,
  submittedNarratives: submittedNarratives.submittedNarratives,
  flaggedAttendance: flaggedAttendance.flaggedAttendance
};
  }

  // =========================
  // COORDINATOR STUDENTS
  // =========================
  static async getStudents(coordinatorUserId) {

    const [[coord]] = await db.query(`
    SELECT department_id
    FROM coordinators
    WHERE user_id = ?
  `, [coordinatorUserId]);

    if (!coord) return [];

    const deptId = coord.department_id;

    const [rows] = await db.query(`
  SELECT 
    s.student_id,
    s.user_id,
    u.photo,
    cr.course_code AS course,
    s.ojt_hours_required,

    COALESCE(
      ROUND(SUM(TIMESTAMPDIFF(MINUTE, a.time_in, a.time_out)) / 60),
      0
    ) AS hours_completed,

    s.company_id,
    comp.company_name AS company,
    u.f_name,
    u.l_name,
    u.photo,

    (
      SELECT COUNT(*) 
      FROM daily_logs dl2
      WHERE dl2.student_id = s.student_id 
      AND dl2.status = 'submitted'
    ) AS submitted_logs,

    (
      SELECT COUNT(*) 
      FROM narrative_reports nr
      WHERE nr.student_id = s.student_id 
      AND nr.status = 'submitted'
    ) AS submitted_narratives

  FROM students s
  JOIN users u ON u.user_id = s.user_id
  LEFT JOIN companies comp ON comp.company_id = s.company_id
  LEFT JOIN courses cr ON cr.course_id = s.course_id
  LEFT JOIN attendance a 
    ON a.student_id = s.student_id
    AND a.time_in IS NOT NULL
    AND a.time_out IS NOT NULL

  WHERE s.department_id = ?
  GROUP BY s.student_id
  ORDER BY u.l_name ASC
`, [deptId]);

    return rows;
  }

  // =========================
  // STUDENT PROGRESS (attendance-based)
  // =========================
  static async getStudentProgress(studentId) {

    // student basic info
    const [[student]] = await db.query(`
    SELECT 
      s.student_id,
      s.ojt_hours_required,
      u.photo,
      cr.course_code AS course,
      comp.company_name AS company,
      u.f_name,
      u.l_name
    FROM students s
    JOIN users u ON u.user_id = s.user_id
    LEFT JOIN courses cr ON cr.course_id = s.course_id
    LEFT JOIN companies comp ON comp.company_id = s.company_id
    WHERE s.student_id = ?
  `, [studentId]);

    if (!student) return null;

    // attendance stats
    const [[stats]] = await db.query(`
    SELECT
      COUNT(*) AS attendance_records,
      COUNT(DISTINCT attendance_date) AS attendance_days,
      ROUND(
        SUM(TIMESTAMPDIFF(MINUTE, time_in, time_out)) / 60
      ) AS hours_completed,
      MAX(attendance_date) AS last_attendance_date
    FROM attendance
    WHERE student_id = ?
      AND time_out IS NOT NULL
  `, [studentId]);

    // recent attendance (last 5)
    const [recent] = await db.query(`
    SELECT
      attendance_date AS date,
      TIME(time_in) AS time_in,
      TIME(time_out) AS time_out,
      ROUND(TIMESTAMPDIFF(MINUTE, time_in, time_out) / 60) AS hours
    FROM attendance
    WHERE student_id = ?
      AND time_out IS NOT NULL
    ORDER BY time_in DESC
    LIMIT 5
  `, [studentId]);

    return {
      student,
      hoursCompleted: stats.hours_completed || 0,
      attendanceRecords: stats.attendance_records || 0,
      attendanceDays: stats.attendance_days || 0,
      lastAttendance: stats.last_attendance_date,
      recentAttendance: recent
    };
  }

  // =========================
  // ASSIGN COMPANY (coordinator)
  // =========================
  static async assignCompany(studentId, companyId) {

    // Check if company exists and is ACTIVE
    const [[company]] = await db.query(
      `SELECT company_id, is_active 
     FROM companies 
     WHERE company_id = ?`,
      [companyId]
    );

    if (!company) {
      throw new Error("Company not found");
    }

    if (company.is_active !== 1) {
      throw new Error("Cannot assign inactive company");
    }

    // Assign company
    await db.query(
      `UPDATE students
     SET company_id = ?
     WHERE student_id = ?`,
      [companyId, studentId]
    );

    // Notify student
    const [[row]] = await db.query(`
    SELECT s.user_id, comp.company_name
    FROM students s
    LEFT JOIN companies comp ON comp.company_id = s.company_id
    WHERE s.student_id = ?
  `, [studentId]);

    if (row?.user_id) {
      await sendNotification({
        user_id: row.user_id,
        title: "OJT Placement Assigned",
        message: `You have been assigned to ${row.company_name}.`,
        type: "placement",
        link: "/student/dashboard"
      });
    }

    return true;
  }
}

module.exports = CoordinatorModel;
