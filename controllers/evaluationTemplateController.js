const db = require("../config/db");


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
      WHERE t.is_master = 1
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

  const coordinatorId = req.user.coordinator_id;

  try {

    const [rows] = await db.query(`
      SELECT
        t.id,
        t.name,
        c.course_code AS courseCode,
        t.academic_year AS academicYear,
        t.is_active AS isActive,
        t.status
      FROM evaluation_templates t
      LEFT JOIN courses c ON c.course_id = t.course_id
      WHERE t.coordinator_id = ?
      ORDER BY t.created_at DESC
    `, [coordinatorId]);

    res.json(rows);

  } catch (err) {
    res.status(500).json({ error: err.message });
  }

};



/* =====================================================
   CREATE MASTER TEMPLATE
===================================================== */
exports.createTemplate = async (req, res) => {

  const {
    name,
    description,
    courseId,
    academicYear,
    active,
    ratingSettings,
    sections
  } = req.body;

  if (!name || !courseId || !ratingSettings) {
    return res.status(400).json({ error: "Invalid template data" });
  }

  const conn = await db.getConnection();
  await conn.beginTransaction();

  try {

    const [tpl] = await conn.query(
      `INSERT INTO evaluation_templates (
        name, description, course_id, academic_year, is_active,
        rating_scale, rating_min_label, rating_max_label,
        is_master, status
      ) VALUES (?,?,?,?,?,?,?,?,1,'draft')`,
      [
        name,
        description,
        courseId,
        academicYear,
        active ? 1 : 0,
        ratingSettings.scale,
        ratingSettings.minLabel,
        ratingSettings.maxLabel
      ]
    );

    const templateId = tpl.insertId;

    await insertSections(conn, templateId, sections);

    await conn.commit();

    res.json({ success: true, id: templateId });

  } catch (err) {

    await conn.rollback();
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
   UPDATE TEMPLATE
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

    await conn.query(
      `UPDATE evaluation_templates
       SET name=?, description=?, course_id=?, academic_year=?,
           is_active=?, rating_scale=?, rating_min_label=?, rating_max_label=?
       WHERE id=?`,
      [
        name,
        description,
        courseId,
        academicYear,
        active ? 1 : 0,
        ratingSettings.scale,
        ratingSettings.minLabel,
        ratingSettings.maxLabel,
        id
      ]
    );

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

    await insertSections(conn, id, sections);

    await conn.commit();

    res.json({ success: true });

  } catch (err) {

    await conn.rollback();
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

  try {

    await db.query(
      `DELETE FROM evaluation_templates WHERE id=?`,
      [id]
    );

    res.json({ success: true });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }

};



/* =====================================================
   COPY MASTER TEMPLATE
===================================================== */
exports.useTemplate = async (req, res) => {

  const { templateId } = req.params;
  const coordinatorId = req.user.coordinator_id;

  try {

    const [[tpl]] = await db.query(
      `SELECT * FROM evaluation_templates WHERE id=?`,
      [templateId]
    );

    const [newTpl] = await db.query(
      `INSERT INTO evaluation_templates (
        name, description, course_id, academic_year,
        is_active, rating_scale, rating_min_label, rating_max_label,
        coordinator_id, is_master, status
      ) VALUES (?,?,?,?,?,?,?,?,?,0,'draft')`,
      [
        tpl.name,
        tpl.description,
        tpl.course_id,
        tpl.academic_year,
        tpl.is_active,
        tpl.rating_scale,
        tpl.rating_min_label,
        tpl.rating_max_label,
        coordinatorId
      ]
    );

    res.json({ success: true, id: newTpl.insertId });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }

};



/* =====================================================
   PUBLISH TEMPLATE
===================================================== */
exports.publishTemplate = async (req, res) => {

  const { id } = req.params;

  try {

    await db.query(
      `UPDATE evaluation_templates
       SET status='published'
       WHERE id=?`,
      [id]
    );

    res.json({
      success: true,
      link: `${process.env.FRONTEND_URL}/evaluate/${id}`
    });

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

    await conn.query(
      `UPDATE evaluation_templates
       SET name=?, description=?, course_id=?, academic_year=?,
           rating_scale=?, rating_min_label=?, rating_max_label=?, is_active=?
       WHERE id=?`,
      [
        formSettings.title,
        formSettings.description,
        formSettings.courseId,
        formSettings.academicYear,
        ratingScale.type,
        ratingScale.minLabel,
        ratingScale.maxLabel,
        formSettings.active ? 1 : 0,
        templateId
      ]
    );

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



/* =====================================================
   HELPERS
===================================================== */

async function loadSections(templateId) {

  const [sections] = await db.query(
    `SELECT * FROM evaluation_sections
     WHERE template_id=?
     ORDER BY sort_order`,
    [templateId]
  );

  for (const s of sections) {

    const [criteria] = await db.query(
      `SELECT * FROM evaluation_criteria
       WHERE section_id=?
       ORDER BY sort_order`,
      [s.id]
    );

    s.criteria = [];

    for (const c of criteria) {

      let options = [];

      if (c.type === "multiple_choice") {

        const [optRows] = await db.query(
          `SELECT id, option_text
           FROM evaluation_options
           WHERE criterion_id=?
           ORDER BY sort_order`,
          [c.id]
        );

        options = optRows;

      }

      s.criteria.push({
        id: c.id,
        title: c.title,
        type: c.type,
        required: !!c.is_required,
        options
      });

    }

  }

  return sections;

}



async function insertSections(conn, templateId, sections) {

  for (let sIndex = 0; sIndex < (sections || []).length; sIndex++) {

    const s = sections[sIndex];

    const [sec] = await conn.query(
      `INSERT INTO evaluation_sections
       (template_id, title, sort_order)
       VALUES (?,?,?)`,
      [templateId, s.title, sIndex]
    );

    const sectionId = sec.insertId;

    for (let cIndex = 0; cIndex < (s.criteria || []).length; cIndex++) {

      const c = s.criteria[cIndex];

      const [crit] = await conn.query(
        `INSERT INTO evaluation_criteria
         (section_id, title, type, is_required, sort_order)
         VALUES (?,?,?,?,?)`,
        [
          sectionId,
          c.title,
          c.type,
          c.required ? 1 : 0,
          cIndex
        ]
      );

      const criterionId = crit.insertId;

      if (c.type === "multiple_choice" && c.options) {

        for (let oIndex = 0; oIndex < c.options.length; oIndex++) {

          await conn.query(
            `INSERT INTO evaluation_options
             (criterion_id, option_text, sort_order)
             VALUES (?,?,?)`,
            [criterionId, c.options[oIndex], oIndex]
          );

        }

      }

    }

  }

}