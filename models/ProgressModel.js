const db = require("../config/db");

class ProgressModel {

  // ─────────────────────────────────────────
  // STUDENT HOURS + INFO
  // ─────────────────────────────────────────
  static async getStudentHours(student_id) {

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
                THEN (
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
                            TIME_TO_SEC(
                              TIMEDIFF(a.time_out, a.time_in)
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
                          a.ot_time_out,
                          a.ot_time_in
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
        ) AS completed_hours

      FROM students s

      LEFT JOIN users u ON u.user_id = s.user_id
      LEFT JOIN companies c ON c.company_id = s.company_id
      LEFT JOIN departments d ON d.department_id = s.department_id
      LEFT JOIN courses crs ON crs.course_id = s.course_id

      LEFT JOIN coordinators co 
        ON co.department_id = s.department_id

      LEFT JOIN users cu 
        ON cu.user_id = co.user_id

      LEFT JOIN attendance a 
        ON a.student_id = s.student_id

      WHERE s.student_id = ?

      GROUP BY s.student_id
      LIMIT 1
    `, [student_id]);

    return rows[0] || null;
  }

  // ─────────────────────────────────────────
  // DAILY LOG STATS
  // ─────────────────────────────────────────
  static async getDailyLogStats(student_id) {

    const [rows] = await db.query(`
      SELECT
        COUNT(*) AS total,
        IFNULL(SUM(status='approved'),0) AS approved,
        IFNULL(SUM(status='submitted'),0) AS submitted,
        IFNULL(SUM(status='revision'),0) AS needsRevision
      FROM daily_logs
      WHERE student_id = ?
    `, [student_id]);

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
  static async getNarrativeStats(student_id) {

    const [rows] = await db.query(`
      SELECT
        COUNT(*) AS total,
        IFNULL(SUM(status='approved'),0) AS approved,
        IFNULL(SUM(status='submitted'),0) AS submitted,
        IFNULL(SUM(status='revision'),0) AS revision
      FROM narrative_reports
      WHERE student_id = ?
    `, [student_id]);

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
  static async getAttendanceStats(student_id) {

    const [rows] = await db.query(`
      SELECT
        COUNT(DISTINCT attendance_date) AS totalDays,

        ROUND(
          IFNULL(
            SUM(
              CASE 
                WHEN location_status = 'verified'
                THEN (
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
                            TIME_TO_SEC(
                              TIMEDIFF(time_out, time_in)
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
        ) AS totalHours,

        MIN(attendance_date) AS firstDate,
        MAX(attendance_date) AS lastDate

      FROM attendance
      WHERE student_id = ?
    `, [student_id]);

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