const db = require("../config/db");

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

class ProgressModel {

  // ─────────────────────────────────────────
  // STUDENT HOURS + INFO
  // ─────────────────────────────────────────
  static async getStudentHours(student_id, academic_year_id) {

    const [rows] = await db.query(`
      SELECT
        MAX(s.ojt_hours_required) AS required_hours,
        MAX(c.company_name) AS company_name,

        MAX(CONCAT(u.f_name, ' ', u.l_name)) AS student_name,
        MAX(d.department_name) AS department_name,
        MAX(crs.course_name) AS course_name,

        MAX(CONCAT(cu.f_name, ' ', cu.l_name)) AS coordinator_name,

        ROUND(
          IFNULL(
            SUM(
              CASE
                WHEN a.location_status = 'verified'
                 AND a.total_seconds > 0
                THEN a.total_seconds
                ELSE 0
              END
            ),
            0
          ) / 3600,
          2
        ) AS completed_hours

      FROM students s

      LEFT JOIN users u ON u.user_id = s.user_id
      LEFT JOIN companies c ON c.company_id = s.company_id
      LEFT JOIN departments d ON d.department_id = s.department_id
      LEFT JOIN courses crs ON crs.course_id = s.course_id

      LEFT JOIN (
        SELECT co1.*
        FROM coordinators co1
        WHERE co1.coordinator_id = (
          SELECT co2.coordinator_id
          FROM coordinators co2
          WHERE co2.department_id = co1.department_id
          ORDER BY co2.coordinator_id DESC
          LIMIT 1
        )
      ) co
        ON co.department_id = s.department_id

      LEFT JOIN users cu
        ON cu.user_id = co.user_id

      LEFT JOIN (
        ${ATTENDANCE_SECONDS_SQL}
      ) a
        ON a.student_id = s.student_id
        AND a.academic_year_id = ?

      WHERE s.student_id = ?
        AND s.academic_year_id = ?

      GROUP BY s.student_id
      LIMIT 1
    `, [academic_year_id, student_id, academic_year_id]);

    return rows[0] || null;
  }

  // ─────────────────────────────────────────
  // DAILY LOG STATS
  // ─────────────────────────────────────────
  static async getDailyLogStats(student_id, academic_year_id) {

    const [rows] = await db.query(`
      SELECT
        COUNT(*) AS total,
        IFNULL(SUM(status='approved'),0) AS approved,
        IFNULL(SUM(status='submitted'),0) AS submitted,
        IFNULL(SUM(status='revision'),0) AS needsRevision
      FROM daily_logs
      WHERE student_id = ?
        AND academic_year_id = ?
    `, [student_id, academic_year_id]);

    return rows[0] || {
      total: 0,
      approved: 0,
      submitted: 0,
      needsRevision: 0
    };
  }

  // ─────────────────────────────────────────
  // NARRATIVE STATS
  // ─────────────────────────────────────────
  static async getNarrativeStats(student_id, academic_year_id) {

    const [rows] = await db.query(`
      SELECT
        COUNT(*) AS total,
        IFNULL(SUM(status='approved'),0) AS approved,
        IFNULL(SUM(status='submitted'),0) AS submitted,
        IFNULL(SUM(status='revision'),0) AS revision
      FROM narrative_reports
      WHERE student_id = ?
        AND academic_year_id = ?
    `, [student_id, academic_year_id]);

    return rows[0] || {
      total: 0,
      approved: 0,
      submitted: 0,
      revision: 0
    };
  }

  // ─────────────────────────────────────────
  // ATTENDANCE STATS
  // ─────────────────────────────────────────
  static async getAttendanceStats(student_id, academic_year_id) {

    const [rows] = await db.query(`
      SELECT
        COUNT(
          DISTINCT CASE
            WHEN a.location_status = 'verified'
             AND a.total_seconds > 0
            THEN a.attendance_date
            ELSE NULL
          END
        ) AS totalDays,

        ROUND(
          IFNULL(
            SUM(
              CASE
                WHEN a.location_status = 'verified'
                 AND a.total_seconds > 0
                THEN a.total_seconds
                ELSE 0
              END
            ),
            0
          ) / 3600,
          2
        ) AS totalHours,

        MIN(a.attendance_date) AS firstDate,
        MAX(a.attendance_date) AS lastDate

      FROM (
        ${ATTENDANCE_SECONDS_SQL}
      ) a

      WHERE a.student_id = ?
        AND a.academic_year_id = ?
    `, [student_id, academic_year_id]);

    const r = rows[0] || {};

    const avgHoursPerDay =
      r.totalDays > 0
        ? Number((r.totalHours / r.totalDays).toFixed(2))
        : 0;

    return {
      totalDays: r.totalDays || 0,
      totalHours: r.totalHours || 0,
      avgHoursPerDay,
      firstDate: r.firstDate || null,
      lastDate: r.lastDate || null
    };
  }

}

module.exports = ProgressModel;