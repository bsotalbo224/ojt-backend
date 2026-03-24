const db = require("../config/db");

/*
LOAD PUBLIC EVALUATION FORM
GET /api/public-evaluation/template/:id
*/

exports.getPublicTemplate = async (req, res) => {
  const { id } = req.params;

  console.log("PUBLIC TEMPLATE REQUEST:", id); 

  try {

    const [[template]] = await db.query(
      `SELECT * FROM evaluation_templates
   WHERE id=? AND is_active=1`,
      [id]
    );

    if (!template) {
      return res.status(404).json({ error: "Template not found" });
    }

    const [sections] = await db.query(
      `SELECT * FROM evaluation_sections
       WHERE template_id=?
       ORDER BY sort_order`,
      [id]
    );

    for (const s of sections) {

      const [criteria] = await db.query(
        `SELECT * FROM evaluation_criteria
         WHERE section_id=?
         ORDER BY sort_order`,
        [s.id]
      );

      for (const c of criteria) {

        // Load options for multiple choice questions
        if (c.type === "multiple_choice") {

          const [options] = await db.query(
            `SELECT id, option_text
             FROM evaluation_options
             WHERE criterion_id=?
             ORDER BY sort_order`,
            [c.id]
          );

          c.options = options;

        }

      }

      s.criteria = criteria;

    }

    res.json({
      formSettings: template,
      sections
    });

  } catch (err) {

    console.error("Public form error:", err);
    res.status(500).json({ error: err.message });

  }
};



/*
SUBMIT PUBLIC EVALUATION
POST /api/public-evaluation/submit
*/

exports.submitEvaluation = async (req, res) => {

  const {
    templateId,
    studentName,
    supervisorName,
    supervisorEmail,
    answers
  } = req.body;

  if (!templateId || !studentName || !answers || !answers.length) {
    return res.status(400).json({ error: "Invalid evaluation data" });
  }

  const conn = await db.getConnection();
  await conn.beginTransaction();

  try {

    const [resp] = await conn.query(
      `INSERT INTO evaluation_responses
       (template_id, student_name, supervisor_name, supervisor_email)
       VALUES (?,?,?,?)`,
      [
        templateId,
        studentName,
        supervisorName,
        supervisorEmail || null
      ]
    );

    const responseId = resp.insertId;

    for (const a of answers) {

      await conn.query(
        `INSERT INTO evaluation_answers
         (response_id, criterion_id, rating_value, yesno_value, text_value, option_id)
         VALUES (?,?,?,?,?,?)`,
        [
          responseId,
          a.criterionId,
          a.type === "rating" ? a.value : null,
          a.type === "yesno" ? (a.value === "Yes" ? 1 : 0) : null,
          a.type === "text" ? a.value : null,
          a.type === "multiple_choice" ? a.value : null
        ]
      );

    }

    await conn.commit();

    res.json({
      success: true,
      responseId
    });

  } catch (err) {

    await conn.rollback();
    console.error("Submit error:", err);

    res.status(500).json({ error: err.message });

  } finally {

    conn.release();

  }

};