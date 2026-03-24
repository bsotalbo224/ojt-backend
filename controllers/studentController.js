const db = require("../config/db");

// ===========================
// STUDENT: GET OJT ASSIGNMENT
// ===========================
exports.getMyAssignment = async (req, res) => {
  const student_id = req.user.student_id;

  try {
    const [rows] = await db.query(`
      SELECT
        c.company_name,
        co.course_name,
        s.ojt_hours_required,
        CONCAT(u.f_name,' ',u.l_name) AS student_name,
        CONCAT(cu.f_name,' ',cu.l_name) AS coordinator_name
      FROM students s
      JOIN users u ON u.user_id = s.user_id
      LEFT JOIN companies c ON c.company_id = s.company_id
      LEFT JOIN courses co ON co.course_id = s.course_id
      LEFT JOIN coordinators cr ON cr.department_id = co.department_id
      LEFT JOIN users cu ON cu.user_id = cr.user_id
      WHERE s.student_id = ?
    `, [student_id]);

    const r = rows[0] || null;

    res.json({
      success: true,
      data: r ? {
        company: r.company_name,
        course: r.course_name,
        required_hours: r.ojt_hours_required,
        coordinator: r.coordinator_name,
        student_name: r.student_name
      } : null
    });

  } catch (err) {
    console.error("GET ASSIGNMENT ERROR:", err);
    res.status(500).json({ success: false });
  }
};

