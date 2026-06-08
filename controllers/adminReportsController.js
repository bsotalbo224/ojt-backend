const db = require("../config/db");

// ===============================
// HOURS SUMMARY
// ===============================
exports.getHoursSummary = async (req, res) => {
  try {

    const academic_year_id = req.query.academic_year_id;

    const [rows] = await db.query(`
      SELECT
        s.student_id AS id,
        CONCAT(u.f_name,' ',u.l_name) AS student,
        c.course_name AS course,

        COUNT(dl.log_id) AS submitted,

        SUM(dl.status = 'approved') AS approved,
        SUM(dl.status = 'revision') AS revision,
        SUM(dl.status = 'missing') AS missing

      FROM students s

      LEFT JOIN users u
        ON s.user_id = u.user_id

      LEFT JOIN courses c
        ON s.course_id = c.course_id

      LEFT JOIN daily_logs dl
        ON s.student_id = dl.student_id
        AND dl.academic_year_id = ?

      WHERE s.academic_year_id = ?

      GROUP BY s.student_id

      ORDER BY student
    `, [
      academic_year_id,
      academic_year_id
    ]);

    res.json(rows);

  } catch (err) {

    console.error("HOURS SUMMARY ERROR:", err);

    res.status(500).json({
      message: "Server error"
    });

  }
};

// ===============================
// ATTENDANCE SUMMARY
// ===============================
exports.getAttendanceSummary = async (req, res) => {
  try {

    const academic_year_id = req.query.academic_year_id;

    const [rows] = await db.query(`
      SELECT
        s.student_id AS id,

        CONCAT(u.f_name,' ',u.l_name) AS student,

        c.course_name AS course,

        comp.company_name AS company,

        s.ojt_hours_required AS required,

        ROUND(
          IFNULL(
            SUM(
              (
                (
                  IFNULL(
                    TIME_TO_SEC(
                      TIMEDIFF(a.time_out, a.time_in)
                    ),
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
                            TIMEDIFF(
                              a.time_out,
                              a.time_in
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
                        a.ot_time_out,
                        a.ot_time_in
                      )
                    ),
                    0
                  )
              ) / 3600
            ),
            0
          ),
          2
        ) AS rendered

      FROM students s

      LEFT JOIN users u
        ON s.user_id = u.user_id

      LEFT JOIN courses c
        ON s.course_id = c.course_id

      LEFT JOIN companies comp
        ON s.company_id = comp.company_id

      LEFT JOIN attendance a
        ON s.student_id = a.student_id
        AND a.academic_year_id = ?

      WHERE s.academic_year_id = ?

      GROUP BY s.student_id

      ORDER BY student
    `, [
      academic_year_id,
      academic_year_id
    ]);

    res.json(rows);

  } catch (err) {

    console.error(
      "ATTENDANCE SUMMARY ERROR:",
      err
    );

    res.status(500).json({
      message: "Server error"
    });

  }
};

// ===============================
// DEPLOYMENT SUMMARY
// ===============================
exports.getDeploymentSummary = async (req, res) => {
  try {

    const academic_year_id = req.query.academic_year_id;

    const [rows] = await db.query(`
      SELECT
        s.student_id AS id,

        CONCAT(u.f_name,' ',u.l_name) AS student,

        c.course_name AS course,

        comp.company_name AS company,

        CONCAT(
          cu.f_name,
          ' ',
          cu.l_name
        ) AS coordinator

      FROM students s

      LEFT JOIN users u
        ON s.user_id = u.user_id

      LEFT JOIN courses c
        ON s.course_id = c.course_id

      LEFT JOIN companies comp
        ON s.company_id = comp.company_id

      LEFT JOIN coordinators coord
        ON s.department_id = coord.department_id

      LEFT JOIN users cu
        ON coord.user_id = cu.user_id

      WHERE s.academic_year_id = ?

      ORDER BY student
    `, [academic_year_id]);

    res.json(rows);

  } catch (err) {

    console.error(
      "DEPLOYMENT SUMMARY ERROR:",
      err
    );

    res.status(500).json({
      message: "Server error"
    });

  }
};

// ===============================
// COMPANY SUMMARY
// ===============================
exports.getCompanySummary = async (req, res) => {
  try {

    const academic_year_id = req.query.academic_year_id;

    const [rows] = await db.query(`
      SELECT
        comp.company_id AS id,

        comp.company_name AS company,

        COUNT(s.student_id) AS assigned

      FROM companies comp

      LEFT JOIN students s
        ON comp.company_id = s.company_id
        AND s.academic_year_id = ?

      GROUP BY comp.company_id

      ORDER BY assigned DESC
    `, [academic_year_id]);

    res.json(rows);

  } catch (err) {

    console.error(
      "DEPARTMENT SUMMARY ERROR:",
      err
    );

    res.status(500).json({
      message: "Server error"
    });

  }
};