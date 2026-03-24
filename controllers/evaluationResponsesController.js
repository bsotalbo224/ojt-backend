const db = require("../config/db");


/* =========================
   LIST ALL EVALUATION RESPONSES
   Used in Coordinator Dashboard
========================= */
exports.getResponses = async (req, res) => {
  try {
    const coordinatorId = req.user.coordinator_id;

    // 🔥 Get coordinator department
    const [[coord]] = await db.query(
      `SELECT department_id FROM coordinators WHERE coordinator_id = ?`,
      [coordinatorId]
    );

    if (!coord) {
      return res.status(403).json({ error: "Coordinator not found" });
    }

    const departmentId = coord.department_id;

    // 🔥 Filter responses by department via template → course
    const [rows] = await db.query(`
      SELECT
        r.id,
        r.student_name,
        r.supervisor_name,
        r.supervisor_email,
        r.submitted_at,
        t.name AS template_name
      FROM evaluation_responses r
      JOIN evaluation_templates t ON t.id = r.template_id
      JOIN courses c ON t.course_id = c.course_id
      WHERE c.department_id = ?
      ORDER BY r.submitted_at DESC
    `, [departmentId]);

    res.json(rows);

  } catch (err) {
    console.error("Get responses error:", err);
    res.status(500).json({ error: err.message });
  }
};



/* =========================
   GET SINGLE RESPONSE DETAILS
========================= */
exports.getResponseDetails = async (req, res) => {
  const { id } = req.params;

  try {
    const coordinatorId = req.user.coordinator_id;

    // 🔥 Get coordinator department
    const [[coord]] = await db.query(
      `SELECT department_id FROM coordinators WHERE coordinator_id = ?`,
      [coordinatorId]
    );

    if (!coord) {
      return res.status(403).json({ error: "Coordinator not found" });
    }

    const departmentId = coord.department_id;

    // 🔥 Get response WITH department check
    const [[response]] = await db.query(
      `SELECT
        r.*,
        t.name AS template_name,
        c.department_id
       FROM evaluation_responses r
       JOIN evaluation_templates t ON t.id = r.template_id
       JOIN courses c ON t.course_id = c.course_id
       WHERE r.id = ?`,
      [id]
    );

    if (!response) {
      return res.status(404).json({ error: "Response not found" });
    }

    // 🔒 SECURITY CHECK
    if (response.department_id !== departmentId) {
      return res.status(403).json({ error: "Unauthorized access" });
    }

    // Answers (unchanged)
    const [answers] = await db.query(`
      SELECT
        a.id,
        a.criterion_id,
        a.rating_value,
        a.yesno_value,
        a.text_value,
        a.option_id,

        c.title AS criterion_title,
        c.type AS criterion_type,

        s.title AS section_title,

        o.option_text AS selected_option

      FROM evaluation_answers a
      JOIN evaluation_criteria c ON c.id = a.criterion_id
      JOIN evaluation_sections s ON s.id = c.section_id
      LEFT JOIN evaluation_options o ON o.id = a.option_id
      WHERE a.response_id = ?
      ORDER BY s.sort_order, c.sort_order
    `, [id]);

    res.json({
      response,
      answers
    });

  } catch (err) {
    console.error("Get response details error:", err);
    res.status(500).json({ error: err.message });
  }
};  