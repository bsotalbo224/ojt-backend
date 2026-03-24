const db = require("../config/db");

class ReportModel {

  // =========================
  // STUDENT OJT SUMMARY
  // =========================
  static async getStudentSummary() {
    const [rows] = await db.query(`
      SELECT 
        s.student_id,
        CONCAT(u.f_name,' ',u.l_name) AS student_name,
        c.course_name,
        d.department_name,
        comp.company_name,
        s.ojt_hours_required AS required_hours,

        IFNULL(
          SUM(
            TIME_TO_SEC(TIMEDIFF(a.time_out, a.time_in)) / 3600
          ), 0
        ) AS completed_hours

      FROM students s
      JOIN users u ON s.user_id = u.user_id
      LEFT JOIN courses c ON s.course_id = c.course_id
      LEFT JOIN departments d ON c.department_id = d.department_id
      LEFT JOIN companies comp ON s.company_id = comp.company_id
      LEFT JOIN attendance a 
        ON s.student_id = a.student_id
        AND a.time_out IS NOT NULL

      GROUP BY 
        s.student_id,
        u.f_name,
        u.l_name,
        c.course_name,
        d.department_name,
        comp.company_name,
        s.ojt_hours_required

      ORDER BY u.l_name ASC
    `);

    return rows;
  }

  // =========================
  // SUMMARY BY DEPARTMENT
  // =========================
  static async getByDepartment(department_id) {
    const [rows] = await db.query(`
      SELECT 
        s.student_id,
        CONCAT(u.f_name,' ',u.l_name) AS student_name,
        c.course_name,
        comp.company_name,
        s.ojt_hours_required,

        IFNULL(
          SUM(
            TIME_TO_SEC(TIMEDIFF(a.time_out, a.time_in)) / 3600
          ), 0
        ) AS completed_hours

      FROM students s
      JOIN users u ON s.user_id = u.user_id
      JOIN courses c ON s.course_id = c.course_id
      LEFT JOIN companies comp ON s.company_id = comp.company_id
      LEFT JOIN attendance a 
        ON s.student_id = a.student_id
        AND a.time_out IS NOT NULL

      WHERE c.department_id = ?

      GROUP BY 
        s.student_id,
        u.f_name,
        u.l_name,
        c.course_name,
        comp.company_name,
        s.ojt_hours_required

      ORDER BY u.l_name ASC
    `, [department_id]);

    return rows;
  }

  // =========================
  // COMPANY DEPLOYMENT
  // =========================
  static async getCompanyDeployment() {
    const [rows] = await db.query(`
      SELECT 
        comp.company_id,
        comp.company_name,
        COUNT(s.student_id) AS total_students
      FROM companies comp
      LEFT JOIN students s 
        ON comp.company_id = s.company_id
      GROUP BY comp.company_id, comp.company_name
      ORDER BY comp.company_name ASC
    `);

    return rows;
  }

  // =========================
  // COMPLETION STATS
  // =========================
  static async getCompletionStats() {
    const [rows] = await db.query(`
      SELECT
        COUNT(*) AS total_students,
        SUM(
          CASE 
            WHEN completed_hours >= required_hours 
            THEN 1 ELSE 0 
          END
        ) AS completed
      FROM (
        SELECT 
          s.student_id,
          s.ojt_hours_required AS required_hours,
          IFNULL(
            SUM(
              TIME_TO_SEC(TIMEDIFF(a.time_out, a.time_in)) / 3600
            ), 0
          ) AS completed_hours
        FROM students s
        LEFT JOIN attendance a 
          ON s.student_id = a.student_id
          AND a.time_out IS NOT NULL
        GROUP BY s.student_id, s.ojt_hours_required
      ) t
    `);

    return rows[0];
  }

}

module.exports = ReportModel;
