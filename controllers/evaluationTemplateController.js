const db = require("../config/db");

const insertSections = async (conn, templateId, sections) => {
  if (!Array.isArray(sections)) return;

  for (const section of sections) {
    const [sectionResult] = await conn.query(
      `INSERT INTO evaluation_sections (template_id, title)
       VALUES (?, ?)`,
      [templateId, section.title]
    );

    const sectionId = sectionResult.insertId;

    if (Array.isArray(section.criteria)) {
      for (const crit of section.criteria) {
        const [critResult] = await conn.query(
          `INSERT INTO evaluation_criteria (section_id, title, type)
           VALUES (?, ?, ?)`,
          [sectionId, crit.title || crit.question || crit.label || "", crit.type || "rating"]
        );

        const criterionId = critResult.insertId;

        // Optional: multiple choice
        if (crit.type === "multiple_choice" && Array.isArray(crit.options)) {
          for (const opt of crit.options) {
            await conn.query(
              `INSERT INTO evaluation_options (criterion_id, option_text)
               VALUES (?, ?)`,
              [criterionId, opt]
            );
          }
        }
      }
    }
  }
};

const loadSections = async (templateId) => {
  const [sections] = await db.query(
    `SELECT id, title
     FROM evaluation_sections
     WHERE template_id = ?
     ORDER BY sort_order ASC`,
    [templateId]
  );

  const result = [];

  for (const section of sections) {
    const [criteria] = await db.query(
      `SELECT id, title, type
       FROM evaluation_criteria
       WHERE section_id = ?
       ORDER BY sort_order ASC`,
      [section.id]
    );

    result.push({
      id: section.id,
      title: section.title,
      criteria: criteria.map(c => ({
        id: c.id,
        title: c.title,
        type: c.type
      }))
    });
  }

  return result;
};

/* =====================================================
   LIST ADMIN TEMPLATES
===================================================== */
exports.listAdminTemplates = async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT
        t.id,
        t.name,
        c.course_code AS courseCode,
        t.academic_year AS academicYear,
        t.is_active AS isActive,
        t.status,
        t.link,
        t.is_accepting_responses AS isAcceptingResponses,
        t.created_at AS createdAt,

        (
          SELECT COUNT(*)
          FROM evaluation_sections s
          WHERE s.template_id = t.id
        ) AS sections,

        (
          SELECT COUNT(*)
          FROM evaluation_criteria a
          JOIN evaluation_sections s ON s.id = a.section_id
          WHERE s.template_id = t.id
        ) AS criteria

      FROM evaluation_templates t
      LEFT JOIN courses c ON c.course_id = t.course_id
      ORDER BY t.created_at DESC
    `);

    res.json(rows);
  } catch (err) {
    console.error("ADMIN LIST ERROR:", err);
    res.status(500).json({ error: err.message });
  }
};

/* =====================================================
   LIST COORDINATOR TEMPLATES
===================================================== */
exports.listCoordinatorTemplates = async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT
        t.id,
        t.name,
        c.course_code AS courseCode,
        t.academic_year AS academicYear,
        t.is_active AS isActive,
        t.status,
        t.link,
        t.is_accepting_responses AS isAcceptingResponses,
        t.created_at AS createdAt
      FROM evaluation_templates t
      LEFT JOIN courses c ON c.course_id = t.course_id
      WHERE t.is_active = 1
      ORDER BY t.created_at DESC
    `);

    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

/* =====================================================
   TOGGLE ACTIVE (ADMIN ONLY)
===================================================== */
exports.toggleActiveTemplate = async (req, res) => {
  const { id } = req.params;

  try {
    const [[row]] = await db.query(
      `SELECT is_active FROM evaluation_templates WHERE id = ?`,
      [id]
    );

    if (!row) {
      return res.status(404).json({ error: "Template not found" });
    }

    const newStatus = row.is_active ? 0 : 1;

    await db.query(
      `UPDATE evaluation_templates SET is_active = ? WHERE id = ?`,
      [newStatus, id]
    );

    res.json({ success: true, is_active: newStatus });

  } catch (err) {
    console.error("TOGGLE ACTIVE ERROR:", err);
    res.status(500).json({ error: err.message });
  }
};

/* =====================================================
   CREATE TEMPLATE
===================================================== */
exports.createTemplate = async (req, res) => {
  const {
    name,
    description,
    courseId,
    academicYear,
    ratingSettings,
    sections
  } = req.body;

  if (!name || !courseId || !ratingSettings) {
    return res.status(400).json({ error: "Invalid template data" });
  }

  const conn = await db.getConnection();
  await conn.beginTransaction();

  try {
    const [tpl] = await conn.query(`
      INSERT INTO evaluation_templates (
        name, description, course_id, academic_year,
        is_active, rating_scale, rating_min_label, rating_max_label,
        status, is_accepting_responses
      ) VALUES (?,?,?,?,?,?,?,?,?,?)
    `, [
      name,
      description,
      courseId,
      academicYear,
      0,
      ratingSettings.scale,
      ratingSettings.minLabel,
      ratingSettings.maxLabel,
      "draft",
      1
    ]);

    const templateId = tpl.insertId;

    const safeSections = Array.isArray(sections) ? sections : [];

    if (safeSections.length > 0) {
      await insertSections(conn, templateId, safeSections);
    }

    await conn.commit();

    res.json({ success: true, id: templateId });

  } catch (err) {
    await conn.rollback();
    console.error(" CREATE TEMPLATE ERROR:", err);
    res.status(500).json({ error: err.message });
  } finally {
    conn.release();
  }
};

/* =====================================================
   GET TEMPLATE
===================================================== */
exports.getTemplate = async (req, res) => {
  const { id } = req.params;

  try {
    const [[tpl]] = await db.query(
      `SELECT * FROM evaluation_templates WHERE id=?`,
      [id]
    );

    if (!tpl) {
      return res.status(404).json({ error: "Template not found" });
    }

    const sections = await loadSections(id);

    res.json({
      id: tpl.id,
      name: tpl.name,
      description: tpl.description,
      courseId: tpl.course_id,
      academicYear: tpl.academic_year,
      active: !!tpl.is_active,
      status: tpl.status,
      link: tpl.link,
      isAcceptingResponses: !!tpl.is_accepting_responses,
      ratingSettings: {
        scale: tpl.rating_scale,
        minLabel: tpl.rating_min_label,
        maxLabel: tpl.rating_max_label
      },
      sections
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

/* =====================================================
   UPDATE TEMPLATE (FIXED)
===================================================== */
exports.updateTemplate = async (req, res) => {
  const { id } = req.params;
  const {
    name,
    description,
    courseId,
    academicYear,
    active,
    ratingSettings,
    sections
  } = req.body;

  const conn = await db.getConnection();
  await conn.beginTransaction();

  try {
    const safeRating = ratingSettings || {
      scale: "1-5",
      minLabel: "Poor",
      maxLabel: "Excellent"
    };

    await conn.query(`
      UPDATE evaluation_templates
      SET name=?, description=?, course_id=?, academic_year=?,
          is_active=?, rating_scale=?, rating_min_label=?, rating_max_label=?
      WHERE id=?
    `, [
      name,
      description,
      courseId,
      academicYear,
      active ? 1 : 0,
      safeRating.scale,
      safeRating.minLabel,
      safeRating.maxLabel,
      id
    ]);

    await conn.query(`
      DELETE FROM evaluation_criteria
      WHERE section_id IN (
        SELECT id FROM evaluation_sections WHERE template_id=?
      )
    `, [id]);

    await conn.query(
      `DELETE FROM evaluation_sections WHERE template_id=?`,
      [id]
    );

    const safeSections = Array.isArray(sections) ? sections : [];

    if (safeSections.length > 0) {
      await insertSections(conn, id, safeSections);
    }

    await conn.commit();  

    res.json({ success: true });

  } catch (err) {
    await conn.rollback();
    console.error("UPDATE ERROR:", err);
    res.status(500).json({ error: err.message });
  } finally {
    conn.release();
  }
};

/* =====================================================
   DELETE TEMPLATE
===================================================== */
exports.deleteTemplate = async (req, res) => {
  const { id } = req.params;

  const conn = await db.getConnection();
  await conn.beginTransaction();

  try {
    // Delete answers
    await conn.query(`
      DELETE ea FROM evaluation_answers ea
      JOIN evaluation_criteria ec ON ea.criterion_id = ec.id
      JOIN evaluation_sections es ON ec.section_id = es.id
      WHERE es.template_id = ?
    `, [id]);

    // Delete options
    await conn.query(`
      DELETE eo FROM evaluation_options eo
      JOIN evaluation_criteria ec ON eo.criterion_id = ec.id
      JOIN evaluation_sections es ON ec.section_id = es.id
      WHERE es.template_id = ?
    `, [id]);

    // Delete criteria
    await conn.query(`
      DELETE ec FROM evaluation_criteria ec
      JOIN evaluation_sections es ON ec.section_id = es.id
      WHERE es.template_id = ?
    `, [id]);

    // Delete sections
    await conn.query(
      `DELETE FROM evaluation_sections WHERE template_id = ?`,
      [id]
    );

    // Delete template
    await conn.query(
      `DELETE FROM evaluation_templates WHERE id = ?`,
      [id]
    );

    await conn.commit();

    res.json({ success: true });

  } catch (err) {
    await conn.rollback();
    console.error("DELETE TEMPLATE ERROR:", err);
    res.status(500).json({ error: err.message });
  } finally {
    conn.release();
  }
};

/* =====================================================
   PUBLISH TEMPLATE (UPDATED)
===================================================== */
exports.publishTemplate = async (req, res) => {
  const { id } = req.params;

  try {
    const link = `${process.env.CLIENT_URL}/evaluate/${id}`;

    await db.query(`
      UPDATE evaluation_templates
      SET status='published',
          is_active = 1,
          link = ?,
          is_accepting_responses = 1
      WHERE id=?
    `, [link, id]);

    res.json({
      success: true,
      link
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

/* =====================================================
   TOGGLE ACCEPTING RESPONSES
===================================================== */
exports.toggleAcceptingResponses = async (req, res) => {
  const { id } = req.params;
  const { accepting } = req.body;

  try {
    await db.query(`
      UPDATE evaluation_templates
      SET is_accepting_responses = ?
      WHERE id = ?
    `, [accepting ? 1 : 0, id]);

    res.json({ success: true });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

/* =====================================================
   BUILDER
===================================================== */
exports.getBuilder = async (req, res) => {
  const { templateId } = req.params;

  try {
    const [[tpl]] = await db.query(
      `SELECT * FROM evaluation_templates WHERE id=?`,
      [templateId]
    );

    const sections = await loadSections(templateId);

    res.json({
      template: tpl,
      sections
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.saveBuilder = async (req, res) => {
  const { templateId } = req.params;
  const { formSettings, ratingScale, sections } = req.body;

  const conn = await db.getConnection();
  await conn.beginTransaction();

  try {
    await conn.query(`
      UPDATE evaluation_templates
      SET name=?, description=?, course_id=?, academic_year=?,
          rating_scale=?, rating_min_label=?, rating_max_label=?, is_active=?
      WHERE id=?
    `, [
      formSettings.title,
      formSettings.description,
      formSettings.courseId,
      formSettings.academicYear,
      ratingScale.type,
      ratingScale.minLabel,
      ratingScale.maxLabel,
      formSettings.active ? 1 : 0,
      templateId
    ]);

    await conn.query(`
      DELETE FROM evaluation_criteria
      WHERE section_id IN (
        SELECT id FROM evaluation_sections WHERE template_id=?
      )
    `, [templateId]);

    await conn.query(
      `DELETE FROM evaluation_sections WHERE template_id=?`,
      [templateId]
    );

    await insertSections(conn, templateId, sections);

    await conn.commit();

    res.json({ success: true });

  } catch (err) {
    await conn.rollback();
    res.status(500).json({ error: err.message });
  } finally {
    conn.release();
  }
};