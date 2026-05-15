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
    // =========================
    // GET COORDINATOR DEPARTMENT
    // =========================
    const [[coord]] = await db.query(`
    SELECT department_id
    FROM coordinators
    WHERE user_id = ?
  `, [coordinatorUserId]);

    if (!coord) return null;

    const deptId = coord.department_id;

    // =========================
    // BASIC COUNTS
    // =========================
    const [[students]] = await db.query(`
    SELECT COUNT(*) AS totalStudents
    FROM students
    WHERE department_id = ?
  `, [deptId]);

    const [[ongoing]] = await db.query(`
    SELECT COUNT(*) AS ongoing
    FROM students
    WHERE department_id = ?
    AND company_id IS NOT NULL
  `, [deptId]);

    const [[submittedLogs]] = await db.query(`
    SELECT COUNT(*) AS submittedLogs
    FROM daily_logs dl
    JOIN students s ON s.student_id = dl.student_id
    WHERE s.department_id = ?
    AND dl.status = 'submitted'
  `, [deptId]);

    const [[submittedNarratives]] = await db.query(`
    SELECT COUNT(*) AS submittedNarratives
    FROM narrative_reports n
    JOIN students s ON s.student_id = n.student_id
    WHERE s.department_id = ?
    AND n.status = 'submitted'
  `, [deptId]);

    // =========================
    // FIXED HOURS CALCULATION
    // =========================
    const [[hoursData]] = await db.query(`
  SELECT 
    COALESCE((
      SELECT ROUND(AVG(
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
      ))
      FROM attendance a
      JOIN students s2 ON s2.student_id = a.student_id
      WHERE s2.department_id = ?
      AND a.time_in IS NOT NULL
    ), 0) AS avgHoursLogged,

    COALESCE((
      SELECT ROUND(AVG(NULLIF(c.required_hours, 0)))
      FROM students s3
      JOIN courses c ON c.course_id = s3.course_id
      WHERE s3.department_id = ?
    ), 0) AS requiredHours
`, [deptId, deptId]);

    // =========================
    // FLAGGED ATTENDANCE
    // =========================
    const [[flaggedAttendance]] = await db.query(`
    SELECT COUNT(*) AS flaggedAttendance
    FROM attendance a
    JOIN students s ON s.student_id = a.student_id
    WHERE s.department_id = ?
    AND a.location_status = 'flagged'
  `, [deptId]);

    // =========================
    // RECENT ACTIVITY
    // =========================
    const [recentActivity] = await db.query(`
    (
      SELECT 
        u.f_name,
        u.l_name,
        'log' AS type,
        dl.created_at
      FROM daily_logs dl
      JOIN students s ON s.student_id = dl.student_id
      JOIN users u ON u.user_id = s.user_id
      WHERE s.department_id = ?
      AND dl.status = 'submitted'
    )
    UNION ALL
    (
      SELECT 
        u.f_name,
        u.l_name,
        'narrative' AS type,
        nr.created_at
      FROM narrative_reports nr
      JOIN students s ON s.student_id = nr.student_id
      JOIN users u ON u.user_id = s.user_id
      WHERE s.department_id = ?
      AND nr.status = 'submitted'
    )
    ORDER BY created_at DESC
    LIMIT 3
  `, [deptId, deptId]);

    // =========================
    // FINAL RETURN
    // =========================
    return {
      totalStudents: students.totalStudents || 0,
      ongoing: ongoing.ongoing || 0,
      submittedLogs: submittedLogs.submittedLogs || 0,
      submittedNarratives: submittedNarratives.submittedNarratives || 0,
      flaggedAttendance: flaggedAttendance.flaggedAttendance || 0,

      avgHoursLogged: hoursData.avgHoursLogged || 0,
      requiredHours: hoursData.requiredHours || 0,

      recentActivity: recentActivity || []
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

    u.f_name,
    u.l_name,
    u.email,
    u.photo,

    s.course_id,
    cr.course_code AS course,

    s.ojt_hours_required,
    COALESCE(s.ojt_hours_required, cr.required_hours) AS required_hours,

    COALESCE(a.hours_completed, 0) AS hours_completed,

    s.company_id,
    s.start_time,
    s.end_time,
    comp.company_name AS company,

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

  LEFT JOIN (
  SELECT 
    student_id,

    ROUND(
      SUM(
        (
          (
            IFNULL(
              TIME_TO_SEC(TIMEDIFF(time_out, time_in)),
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
                    TIME_TO_SEC(TIMEDIFF(time_out, time_in)),
                    0
                  ) >= 18000,
                  3600,
                  0
                )
              )
          )

          + IFNULL(
              TIME_TO_SEC(
                TIMEDIFF(ot_time_out, ot_time_in)
              ),
              0
            )
        ) / 3600
      )
    ) AS hours_completed

  FROM attendance

  WHERE time_in IS NOT NULL

  GROUP BY student_id

) a ON a.student_id = s.student_id

  WHERE s.department_id = ?
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
      COALESCE(s.ojt_hours_required, cr.required_hours) AS required_hours,
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
      ROUND(SUM(
(
  (
    IFNULL(
      TIME_TO_SEC(TIMEDIFF(time_out, time_in)),
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
            TIME_TO_SEC(TIMEDIFF(time_out, time_in)),
            0
          ) >= 18000,
          3600,
          0
        )
      )
  )

  + IFNULL(
      TIME_TO_SEC(
        TIMEDIFF(ot_time_out, ot_time_in)
      ),
      0
    )
) / 3600
)) AS hours_completed,
      MAX(attendance_date) AS last_attendance_date
    FROM attendance
    WHERE student_id = ?
  `, [studentId]);

    // recent attendance (last 5)
    const [recent] = await db.query(`
    SELECT
      attendance_date AS date,
      time_in,
      lunch_break_start,
      lunch_break_end,
      time_out,
      ot_time_in,
      ot_time_out
    FROM attendance
    WHERE student_id = ?
    ORDER BY attendance_date DESC
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
  static async assignCompany(
    studentId,
    companyId,
    start_time = "08:30:00",
    end_time = "17:00:00"
  ) {

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
        SET 
          company_id = ?,
          start_time = ?,
          end_time = ?
        WHERE student_id = ?`,
      [
        companyId,
        start_time,
        end_time,
        studentId
      ]
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
