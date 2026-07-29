const db = require("../config/db");
const bcrypt = require("bcryptjs");
const { generatePassword } = require("../utils/password");
const { sendCoordinatorCredentials } = require("../utils/mailer");
const { sendNotification } = require("../services/notificationServices");
const MessageModel = require("./messageModel");
const AcademicYearModel = require("./AcademicYearModel");

const ATTENDANCE_SECONDS_SQL = `
  SELECT
    dur.attendance_id,
    dur.student_id,
    dur.academic_year_id,
    dur.attendance_date,
    dur.location_status,
    (
      dur.work_seconds_raw
      - CASE
          WHEN dur.lunch_break_start IS NOT NULL
           AND dur.lunch_break_end IS NOT NULL
          THEN
            CASE
              WHEN dur.lunch_break_end >= dur.lunch_break_start
              THEN TIME_TO_SEC(
                     TIMEDIFF(
                       dur.lunch_break_end,
                       dur.lunch_break_start
                     )
                   )
              ELSE TIME_TO_SEC(
                     TIMEDIFF(
                       ADDTIME(dur.lunch_break_end, '24:00:00'),
                       dur.lunch_break_start
                     )
                   )
            END
          ELSE
            IF(dur.work_seconds_raw >= 18000, 3600, 0)
        END
      + dur.ot_seconds
    ) AS total_seconds

  FROM (
    SELECT
      eti.attendance_id,
      eti.student_id,
      eti.academic_year_id,
      eti.attendance_date,
      eti.location_status,

      IFNULL(
        CASE
          WHEN eti.time_out IS NULL
           OR eti.effective_time_in IS NULL
          THEN NULL

          WHEN eti.time_out >= eti.effective_time_in
          THEN TIME_TO_SEC(
                 TIMEDIFF(eti.time_out, eti.effective_time_in)
               )

          ELSE TIME_TO_SEC(
                 TIMEDIFF(
                   ADDTIME(eti.time_out, '24:00:00'),
                   eti.effective_time_in
                 )
               )
        END,
        0
      ) AS work_seconds_raw,

      IFNULL(
        CASE
          WHEN eti.ot_time_in IS NOT NULL
           AND eti.ot_time_out IS NOT NULL
          THEN
            CASE
              WHEN eti.ot_time_out >= eti.ot_time_in
              THEN TIME_TO_SEC(
                     TIMEDIFF(eti.ot_time_out, eti.ot_time_in)
                   )
              ELSE TIME_TO_SEC(
                     TIMEDIFF(
                       ADDTIME(eti.ot_time_out, '24:00:00'),
                       eti.ot_time_in
                     )
                   )
            END
          ELSE 0
        END,
        0
      ) AS ot_seconds,

      eti.lunch_break_start,
      eti.lunch_break_end

    FROM (
      SELECT
        att.attendance_id,
        att.student_id,
        att.academic_year_id,
        att.attendance_date,
        att.location_status,
        att.time_out,
        att.lunch_break_start,
        att.lunch_break_end,
        att.ot_time_in,
        att.ot_time_out,

        CASE
          WHEN att.early_attendance = 1
           AND att.early_status = 'approved'
          THEN att.time_in

          WHEN (
            (
              stu.start_time < '18:00:00'
              AND att.time_in < stu.start_time
            )
            OR
            (
              stu.start_time >= '18:00:00'
              AND att.time_in >= '12:00:00'
              AND att.time_in < stu.start_time
            )
          )
          THEN stu.start_time

          ELSE att.time_in
        END AS effective_time_in

      FROM attendance att

      JOIN students stu
        ON stu.student_id = att.student_id
        AND stu.academic_year_id = att.academic_year_id
    ) eti
  ) dur
`;

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

    let coordRes;
    let user_id;
    let plainPassword;

    try {
      await conn.beginTransaction();

      plainPassword = generatePassword(8);
      const hashedPassword = await bcrypt.hash(plainPassword, 10);

      const [userRes] = await conn.query(
        `INSERT INTO users (f_name, l_name, email, password, role)
         VALUES (?, ?, ?, ?, 'coordinator')`,
        [f_name, l_name, email, hashedPassword]
      );

      user_id = userRes.insertId;

      [coordRes] = await conn.query(
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

      // Keep the department consultation group in sync with the newly
      // created coordinator, inside the same transaction as the inserts
      // above. Coordinators aren't academic-year scoped, so the active
      // year is looked up here using the same connection.
      const activeAcademicYear = await AcademicYearModel.getActive(conn);

      if (!activeAcademicYear) {
        throw new Error("No active academic year found");
      }

      await MessageModel.syncDepartmentConversation(
        conn,
        department_id,
        activeAcademicYear.academic_year_id,
        user_id
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

    const conn = await db.getConnection();

    let row;

    try {
      await conn.beginTransaction();

      // Captured before the update so we can detect a department
      // transfer and synchronize both the old and new groups below.
      const [[existing]] = await conn.query(
        `SELECT department_id FROM coordinators WHERE coordinator_id = ?`,
        [coordinator_id]
      );

      const oldDepartmentId = existing ? existing.department_id : null;

      // update user
      await conn.query(
        `UPDATE users u
         JOIN coordinators c ON c.user_id = u.user_id
         SET u.f_name = ?, u.l_name = ?, u.email = ?
         WHERE c.coordinator_id = ?`,
        [f_name, l_name, email, coordinator_id]
      );

      // update coordinator
      await conn.query(
        `UPDATE coordinators
         SET department_id = ?
         WHERE coordinator_id = ?`,
        [department_id, coordinator_id]
      );

      // Read back the persisted value rather than assuming it matches
      // the input — triggers, constraints, or normalization could alter it.
      const [[updated]] = await conn.query(
        `SELECT department_id FROM coordinators WHERE coordinator_id = ?`,
        [coordinator_id]
      );

      const newDepartmentId = updated ? updated.department_id : null;

      // Only re-sync when the coordinator actually moved departments. A
      // transfer means the old group must lose them and the new group
      // must gain them.
      if (oldDepartmentId !== newDepartmentId) {
        const activeAcademicYear = await AcademicYearModel.getActive(conn);

        if (!activeAcademicYear) {
          throw new Error("No active academic year found");
        }

        await MessageModel.syncDepartmentConversation(
          conn,
          oldDepartmentId,
          activeAcademicYear.academic_year_id
        );

        await MessageModel.syncDepartmentConversation(
          conn,
          newDepartmentId,
          activeAcademicYear.academic_year_id
        );
      }

      // return updated joined row
      [[row]] = await conn.query(`
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

      await conn.commit();

    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }

    return row;
  }

  // =========================
  // TOGGLE STATUS (admin)
  // =========================
  static async setStatus(coordinator_id, is_active) {

    const conn = await db.getConnection();

    let row;

    try {
      await conn.beginTransaction();

      await conn.query(
        `UPDATE coordinators
         SET is_active = ?
         WHERE coordinator_id = ?`,
        [is_active, coordinator_id]
      );

      const [[coord]] = await conn.query(
        `SELECT department_id FROM coordinators WHERE coordinator_id = ?`,
        [coordinator_id]
      );

      // Re-syncing removes the coordinator from the group when
      // deactivated and restores them when reactivated. Skip when there's
      // no valid department to sync against.
      if (coord?.department_id != null) {
        const activeAcademicYear = await AcademicYearModel.getActive(conn);

        if (!activeAcademicYear) {
          throw new Error("No active academic year found");
        }

        await MessageModel.syncDepartmentConversation(
          conn,
          coord.department_id,
          activeAcademicYear.academic_year_id
        );
      }

      [[row]] = await conn.query(`
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

      await conn.commit();

    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }

    return row;
  }

  // =========================
  // DASHBOARD STATS (coordinator)
  // =========================
 static async getDashboardStats(coordinatorUserId, academic_year_id) {
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
      AND academic_year_id = ?
    `, [deptId, academic_year_id]);

    const [[ongoing]] = await db.query(`
      SELECT COUNT(*) AS ongoing
      FROM students
      WHERE department_id = ?
      AND company_id IS NOT NULL
      AND academic_year_id = ?
    `, [deptId, academic_year_id]);

    const [[submittedLogs]] = await db.query(`
      SELECT COUNT(*) AS submittedLogs
      FROM daily_logs dl
      JOIN students s ON s.student_id = dl.student_id
      WHERE s.department_id = ?
      AND s.academic_year_id = ?
      AND dl.status = 'submitted'
    `, [deptId, academic_year_id]);

    const [[submittedNarratives]] = await db.query(`
      SELECT COUNT(*) AS submittedNarratives
      FROM narrative_reports n
      JOIN students s ON s.student_id = n.student_id
      WHERE s.department_id = ?
      AND n.academic_year_id = ?
      AND n.status = 'submitted'
    `, [deptId, academic_year_id]);

    // ========================
    // SHIFT STATS
    // Priority: Night (start >= 17:00) > Half-Day (duration <= 5h) > Day
    // Each student belongs to exactly one category.
    // (Scheduled shift classification — not attendance-derived, untouched)
    // ========================
    const [[shiftStats]] = await db.query(`
      SELECT
        SUM(
          CASE
            WHEN TIME(start_time) >= '17:00:00'
            THEN 1
            ELSE 0
          END
        ) AS nightShiftCount,

        SUM(
          CASE
            WHEN TIME(start_time) < '17:00:00'
              AND TIMESTAMPDIFF(
                MINUTE,
                CONCAT('2000-01-01 ', start_time),
                CONCAT('2000-01-01 ', end_time)
              ) <= 300
            THEN 1
            ELSE 0
          END
        ) AS halfDayCount,

        SUM(
          CASE
            WHEN TIME(start_time) < '17:00:00'
              AND TIMESTAMPDIFF(
                MINUTE,
                CONCAT('2000-01-01 ', start_time),
                CONCAT('2000-01-01 ', end_time)
              ) > 300
            THEN 1
            ELSE 0
          END
        ) AS dayShiftCount

      FROM students
      WHERE department_id = ?
      AND academic_year_id = ?
    `, [deptId, academic_year_id]);

    // =========================
    // SHIFT HOURS ANALYTICS
    // Same priority-based classification applied consistently.
    // Uses ATTENDANCE_SECONDS_SQL — only verified, completed
    // (total_seconds > 0) attendance counts toward the average.
    // =========================
    const [[shiftHours]] = await db.query(`
      SELECT

        /* NIGHT SHIFT: start >= 17:00 */
        ROUND(AVG(
          CASE
            WHEN TIME(s.start_time) >= '17:00:00'
            THEN ad.total_seconds / 3600
          END
        )) AS nightAvgHoursLogged,

        /* HALF DAY: start < 17:00 AND scheduled duration <= 5 hours (300 min) */
        ROUND(AVG(
          CASE
            WHEN TIME(s.start_time) < '17:00:00'
              AND TIMESTAMPDIFF(
                MINUTE,
                CONCAT('2000-01-01 ', s.start_time),
                CONCAT('2000-01-01 ', s.end_time)
              ) <= 300
            THEN ad.total_seconds / 3600
          END
        )) AS halfDayAvgHoursLogged,

        /* DAY SHIFT: start < 17:00 AND scheduled duration > 5 hours (300 min) */
        ROUND(AVG(
          CASE
            WHEN TIME(s.start_time) < '17:00:00'
              AND TIMESTAMPDIFF(
                MINUTE,
                CONCAT('2000-01-01 ', s.start_time),
                CONCAT('2000-01-01 ', s.end_time)
              ) > 300
            THEN ad.total_seconds / 3600
          END
        )) AS dayAvgHoursLogged

      FROM students s

      JOIN (
        ${ATTENDANCE_SECONDS_SQL}
      ) ad
        ON ad.student_id = s.student_id
        AND ad.academic_year_id = s.academic_year_id

      WHERE s.department_id = ?
      AND s.academic_year_id = ?
      AND ad.location_status = 'verified'
      AND ad.total_seconds > 0
    `, [deptId, academic_year_id]);

    // =========================
    // SHIFT REQUIRED HOURS
    // Same priority-based classification applied consistently.
    // (Scheduled requirement, not attendance-derived — untouched)
    // =========================
    const [[shiftRequired]] = await db.query(`
      SELECT

        /* NIGHT SHIFT: start >= 17:00 */
        ROUND(AVG(
          CASE
            WHEN TIME(s.start_time) >= '17:00:00'
            THEN COALESCE(s.ojt_hours_required, c.required_hours)
          END
        )) AS nightRequiredHours,

        /* HALF DAY: start < 17:00 AND scheduled duration <= 5 hours (300 min) */
        ROUND(AVG(
          CASE
            WHEN TIME(s.start_time) < '17:00:00'
              AND TIMESTAMPDIFF(
                MINUTE,
                CONCAT('2000-01-01 ', s.start_time),
                CONCAT('2000-01-01 ', s.end_time)
              ) <= 300
            THEN COALESCE(s.ojt_hours_required, c.required_hours)
          END
        )) AS halfDayRequiredHours,

        /* DAY SHIFT: start < 17:00 AND scheduled duration > 5 hours (300 min) */
        ROUND(AVG(
          CASE
            WHEN TIME(s.start_time) < '17:00:00'
              AND TIMESTAMPDIFF(
                MINUTE,
                CONCAT('2000-01-01 ', s.start_time),
                CONCAT('2000-01-01 ', s.end_time)
              ) > 300
            THEN COALESCE(s.ojt_hours_required, c.required_hours)
          END
        )) AS dayRequiredHours

      FROM students s
      JOIN courses c ON c.course_id = s.course_id

      WHERE s.department_id = ?
      AND s.academic_year_id = ?
    `, [deptId, academic_year_id]);

    // =========================
    // FIXED HOURS CALCULATION
    // Uses ATTENDANCE_SECONDS_SQL — only verified, completed
    // (total_seconds > 0) attendance counts toward the average.
    // =========================
    const [[hoursData]] = await db.query(`
      SELECT
        COALESCE((
          SELECT ROUND(AVG(ad.total_seconds / 3600))
          FROM (
            ${ATTENDANCE_SECONDS_SQL}
          ) ad
          JOIN students s2
            ON s2.student_id = ad.student_id
            AND s2.academic_year_id = ad.academic_year_id
          WHERE s2.department_id = ?
          AND ad.academic_year_id = ?
          AND ad.location_status = 'verified'
          AND ad.total_seconds > 0
        ), 0) AS avgHoursLogged,

        COALESCE((
          SELECT ROUND(AVG(NULLIF(c.required_hours, 0)))
          FROM students s3
          JOIN courses c ON c.course_id = s3.course_id
          WHERE s3.department_id = ?
          AND s3.academic_year_id = ?
        ), 0) AS requiredHours
    `, [deptId, academic_year_id, deptId, academic_year_id]);

    // ==========================
    // ATTENDANCE SUMMARY
    // (Live-state counts, not hour math — untouched)
    // ==========================
    const [[attendanceSummary]] = await db.query(`
      SELECT
        SUM(
          CASE
            WHEN time_in IS NOT NULL AND time_out IS NULL
            THEN 1 ELSE 0
          END
        ) AS workingCount,

        SUM(
          CASE
            WHEN lunch_break_start IS NOT NULL AND lunch_break_end IS NULL
            THEN 1 ELSE 0
          END
        ) AS onMealCount,

        SUM(
          CASE
            WHEN ot_time_in IS NOT NULL AND ot_time_out IS NULL
            THEN 1 ELSE 0
          END
        ) AS otActiveCount,

        SUM(
          CASE
            WHEN time_out IS NOT NULL
            THEN 1 ELSE 0
          END
        ) AS completedCount

      FROM attendance a
      JOIN students s ON s.student_id = a.student_id

      WHERE s.department_id = ?
      AND a.academic_year_id = ?
    `, [deptId, academic_year_id]);

    // =========================
    // FLAGGED ATTENDANCE
    // =========================
    const [[flaggedAttendance]] = await db.query(`
      SELECT COUNT(*) AS flaggedAttendance
      FROM attendance a
      JOIN students s ON s.student_id = a.student_id
      WHERE s.department_id = ?
      AND a.academic_year_id = ?
      AND a.location_status = 'flagged'
    `, [deptId, academic_year_id]);

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
        AND s.academic_year_id = ?
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
        AND s.academic_year_id = ?
        AND nr.status = 'submitted'
      )
      ORDER BY created_at DESC
      LIMIT 3
    `, [deptId, academic_year_id, deptId, academic_year_id]);

    // =========================
    // FINAL RETURN
    // =========================
    return {
      totalStudents: students.totalStudents || 0,
      ongoing: ongoing.ongoing || 0,
      submittedLogs: submittedLogs.submittedLogs || 0,
      submittedNarratives: submittedNarratives.submittedNarratives || 0,
      flaggedAttendance: flaggedAttendance.flaggedAttendance || 0,

      workingCount: attendanceSummary.workingCount || 0,
      onMealCount: attendanceSummary.onMealCount || 0,
      otActiveCount: attendanceSummary.otActiveCount || 0,
      completedCount: attendanceSummary.completedCount || 0,

      dayShiftCount: shiftStats.dayShiftCount || 0,
      nightShiftCount: shiftStats.nightShiftCount || 0,
      halfDayCount: shiftStats.halfDayCount || 0,

      avgHoursLogged: hoursData.avgHoursLogged || 0,
      requiredHours: hoursData.requiredHours || 0,

      dayAvgHoursLogged: shiftHours.dayAvgHoursLogged || 0,
      nightAvgHoursLogged: shiftHours.nightAvgHoursLogged || 0,
      halfDayAvgHoursLogged: shiftHours.halfDayAvgHoursLogged || 0,

      dayRequiredHours: shiftRequired.dayRequiredHours || 0,
      nightRequiredHours: shiftRequired.nightRequiredHours || 0,
      halfDayRequiredHours: shiftRequired.halfDayRequiredHours || 0,

      recentActivity: recentActivity || []
    };
  }

  // =========================
  // COORDINATOR STUDENTS
  // =========================
  static async getStudents(coordinatorUserId, academic_year_id) {

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
      AND dl2.academic_year_id = ?
      AND dl2.status = 'submitted'
    ) AS submitted_logs,

    (
      SELECT COUNT(*)
      FROM narrative_reports nr
      WHERE nr.student_id = s.student_id
      AND nr.academic_year_id = ?
      AND nr.status = 'submitted'
    ) AS submitted_narratives

  FROM students s
  JOIN users u ON u.user_id = s.user_id
  LEFT JOIN companies comp ON comp.company_id = s.company_id
  LEFT JOIN courses cr ON cr.course_id = s.course_id

  LEFT JOIN (
    SELECT
      ad.student_id,
      ROUND(SUM(ad.total_seconds) / 3600, 2) AS hours_completed
    FROM (
      ${ATTENDANCE_SECONDS_SQL}
    ) ad
    WHERE ad.academic_year_id = ?
    AND ad.location_status = 'verified'
    AND ad.total_seconds > 0
    GROUP BY ad.student_id
  ) a ON a.student_id = s.student_id

  WHERE s.department_id = ?
  AND s.academic_year_id = ?
  ORDER BY u.l_name ASC
`, [
      academic_year_id,
      academic_year_id,
      academic_year_id,
      deptId,
      academic_year_id
    ]);

    return rows;
  }

  // =========================
  // STUDENT PROGRESS (attendance-based)
  //
  // coordinatorUserId is optional: pass it to enforce that the
  // requesting coordinator may only view students in their own
  // department. Omit it (or pass null) for admin-initiated calls
  // where the route layer has already authorized the request.
  // =========================
  static async getStudentProgress(studentId, academic_year_id, coordinatorUserId = null) {

    // student basic info
    const [[studentRow]] = await db.query(`
    SELECT 
      s.student_id,
      s.department_id,
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
    AND s.academic_year_id = ?
  `, [
      studentId,
      academic_year_id
    ]);

    if (!studentRow) return null;

    // =========================
    // COORDINATOR DEPARTMENT VALIDATION
    // =========================
    if (coordinatorUserId) {
      const [[coord]] = await db.query(`
        SELECT department_id
        FROM coordinators
        WHERE user_id = ?
      `, [coordinatorUserId]);

      if (!coord || coord.department_id !== studentRow.department_id) {
        throw new Error("Unauthorized student access");
      }
    }

    // strip department_id before returning — not part of the
    // existing response shape, only needed for the check above
    const { department_id, ...student } = studentRow;

    // attendance stats
    // (record/day counts include all rows; hours_completed only
    // counts verified, completed (total_seconds > 0) attendance)
    const [[stats]] = await db.query(`
    SELECT
      COUNT(*) AS attendance_records,
      COUNT(
        DISTINCT CASE
          WHEN ad.location_status = 'verified'
           AND ad.total_seconds > 0
          THEN ad.attendance_date
          ELSE NULL
        END
      ) AS attendance_days,
      ROUND(
        SUM(
          CASE
            WHEN ad.location_status = 'verified'
             AND ad.total_seconds > 0
            THEN ad.total_seconds
            ELSE 0
          END
        ) / 3600
      ) AS hours_completed,
      MAX(ad.attendance_date) AS last_attendance_date
    FROM (
      ${ATTENDANCE_SECONDS_SQL}
    ) ad
    WHERE ad.student_id = ?
    AND ad.academic_year_id = ?
  `, [studentId, academic_year_id]);

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
    AND academic_year_id = ?
    ORDER BY attendance_date DESC
    LIMIT 5
  `, [studentId, academic_year_id]);

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
    end_time = "17:00:00",
    academic_year_id
  ) {

    if (!academic_year_id) {
      throw new Error("academic_year_id is required");
    }

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

    // Assign company (scoped to this academic year's enrollment record)
    const [result] = await db.query(
      `UPDATE students
        SET 
          company_id = ?,
          start_time = ?,
          end_time = ?
        WHERE student_id = ?
        AND academic_year_id = ?`,
      [
        companyId,
        start_time,
        end_time,
        studentId,
        academic_year_id
      ]
    );

    if (result.affectedRows === 0) {
      throw new Error("Student not found for current academic year");
    }

    // Notify student
    const [[row]] = await db.query(`
      SELECT
        s.user_id,
        s.academic_year_id,
        comp.company_name
      FROM students s
      LEFT JOIN companies comp
        ON comp.company_id = s.company_id
      WHERE s.student_id = ?
      AND s.academic_year_id = ?
    `, [studentId, academic_year_id]);

    if (row?.user_id) {
      await sendNotification({
        user_id: row.user_id,
        title: "OJT Placement Assigned",
        message: `You have been assigned to ${row.company_name}.`,
        type: "placement",
        link: "/student/dashboard",
        academic_year_id: row.academic_year_id
      });
    }

    return true;
  }
}

module.exports = CoordinatorModel;