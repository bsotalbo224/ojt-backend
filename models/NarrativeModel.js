const db = require("../config/db");
const { sendNotification } = require("../services/notificationServices");

class NarrativeModel {

  // =========================
  // STUDENT NARRATIVES
  // =========================
  static async getByStudent(student_id) {

    const [rows] = await db.query(`
      SELECT 
        n.*,
        CONCAT(u.f_name, ' ', u.l_name) AS student_name,
        cr.course_code AS course,
        comp.company_name AS company
      FROM narrative_reports n
      JOIN students s ON n.student_id = s.student_id
      JOIN users u ON s.user_id = u.user_id
      LEFT JOIN courses cr ON s.course_id = cr.course_id
      LEFT JOIN companies comp ON s.company_id = comp.company_id
      WHERE n.student_id = ?
      ORDER BY n.narrative_date DESC
    `, [student_id]);

    return rows;
  }


  // =========================
  // GET SINGLE NARRATIVE
  // =========================
  static async getById(narrative_id) {

    const [[row]] = await db.query(`
      SELECT
        n.*,
        CONCAT(u.f_name,' ',u.l_name) AS student_name,
        u.photo,
        cr.course_code AS course,
        comp.company_name AS company
      FROM narrative_reports n
      JOIN students s ON n.student_id = s.student_id
      JOIN users u ON s.user_id = u.user_id
      LEFT JOIN courses cr ON s.course_id = cr.course_id
      LEFT JOIN companies comp ON s.company_id = comp.company_id
      WHERE n.narrative_id = ?
      LIMIT 1
    `, [narrative_id]);

    return row || null;
  }


// =========================
// COORDINATOR VIEW
// =========================
static async getByDepartment(department_id) {

  const [rows] = await db.query(`
    SELECT 
      n.*,
      CONCAT(u.f_name,' ',u.l_name) AS student_name,
      u.photo,
      comp.company_name AS company,
      cr.course_code AS course
    FROM narrative_reports n
    JOIN students s ON n.student_id = s.student_id
    JOIN users u ON s.user_id = u.user_id
    LEFT JOIN courses cr ON s.course_id = cr.course_id
    LEFT JOIN companies comp ON s.company_id = comp.company_id
    JOIN courses c ON s.course_id = c.course_id
    WHERE c.department_id = ?
    AND n.status IN ('submitted','revision','approved')
    ORDER BY n.narrative_date DESC
  `, [department_id]);

  // =========================
  // ATTACHMENTS
  // =========================

  if (rows.length > 0) {

    const narrativeIds = rows.map(n => n.narrative_id);

    const [attachments] = await db.query(`
      SELECT narrative_id, file_path
      FROM attachments
      WHERE narrative_id IN (?)
    `, [narrativeIds]);

    // Group attachments by narrative_id
    const attachmentMap = {};
    attachments.forEach(att => {
      if (!attachmentMap[att.narrative_id]) {
        attachmentMap[att.narrative_id] = [];
      }
      attachmentMap[att.narrative_id].push(att.file_path);
    });

    // Attach to each narrative
    rows.forEach(narrative => {
      narrative.attachments = attachmentMap[narrative.narrative_id] || [];
    });

  }

  return rows;
}


  // =========================
  // CREATE OR UPDATE NARRATIVE
  // =========================
  static async create(data) {

    let { narrative_id, student_id, narrative_date, content, status } = data;

    if (!["submitted", "draft"].includes(status)) {
      status = "draft";
    }

    let narrativeId;

    // =====================================
    // UPDATE EXISTING (REVISION / EDIT)
    // =====================================
    if (narrative_id) {

      const [[existing]] = await db.query(`
        SELECT status
        FROM narrative_reports
        WHERE narrative_id = ?
        AND student_id = ?
      `, [narrative_id, student_id]);

      if (!existing) {
        throw new Error("Narrative not found.");
      }

      // Prevent editing approved narratives
      if (existing.status === "approved") {
        throw new Error("Approved narratives cannot be edited.");
      }

      await db.query(`
        UPDATE narrative_reports
        SET 
          content = ?, 
          status = ?, 
          coordinator_remarks = NULL,
          updated_at = CURRENT_TIMESTAMP
        WHERE narrative_id = ?
        AND student_id = ?
      `, [content, status, narrative_id, student_id]);

      narrativeId = narrative_id;

    }
    // =====================================
    // CREATE NEW NARRATIVE
    // =====================================
    else {

      const [result] = await db.query(`
        INSERT INTO narrative_reports
        (student_id, narrative_date, content, status, report_period)
        VALUES (?, ?, ?, ?, 'weekly')
      `, [student_id, narrative_date, content, status]);

      narrativeId = result.insertId;
    }


    // =====================================
    // NOTIFY COORDINATOR IF SUBMITTED
    // =====================================
    if (status === "submitted") {

      const [[coord]] = await db.query(`
        SELECT co.user_id
        FROM students s
        JOIN courses c ON s.course_id = c.course_id
        JOIN coordinators co ON co.department_id = c.department_id
        WHERE s.student_id = ?
        LIMIT 1
      `, [student_id]);

      if (coord?.user_id) {

        await sendNotification({
          user_id: coord.user_id,
          title: "Narrative Submitted",
          message: "A student submitted a daily narrative report.",
          type: "narrative",
          link: "/coordinator/narratives"
        });

      }
    }

    return narrativeId;
  }


  // =========================
  // GET NARRATIVE ATTACHMENTS
  // =========================
  static async getAttachments(narrative_id) {

    const [rows] = await db.query(`
      SELECT 
        attachment_id,
        file_name,
        file_path,
        file_type,
        uploaded_at
      FROM attachments
      WHERE narrative_id = ?
      ORDER BY uploaded_at DESC
    `, [narrative_id]);

    return rows;
  }


  // =========================
  // UPDATE STATUS (Coordinator)
  // =========================
  static async updateStatus(id, status, remarks) {

    await db.query(`
      UPDATE narrative_reports
      SET status = ?, coordinator_remarks = ?
      WHERE narrative_id = ?
    `, [status, remarks, id]);

    const [[row]] = await db.query(`
      SELECT 
        s.user_id,
        n.narrative_date
      FROM narrative_reports n
      JOIN students s ON n.student_id = s.student_id
      WHERE n.narrative_id = ?
    `, [id]);

    if (!row?.user_id) return;

    let title;
    let message;

    if (status === "approved") {

      title = "Narrative Approved";
      message = "Your narrative report was approved.";

    } else if (status === "revision") {

      title = "Narrative Needs Revision";
      message = "Your narrative report needs revision. Please review the coordinator remarks.";

    } else {

      title = "Narrative Updated";
      message = "Your narrative report status has been updated.";

    }

    await sendNotification({
      user_id: row.user_id,
      title,
      message,
      type: "narrative",
      link: `/student/narratives?revision=${id}`
    });


    // Consultation system message
    if (status === "revision") {

      await db.query(`
        INSERT INTO messages
        (sender_id, receiver_id, message, message_type, related_narrative_id)
        VALUES (?, ?, ?, 'system', ?)
      `, [
        null,
        row.user_id,
        `Coordinator commented on your Daily Narrative (${row.narrative_date})`,
        id
      ]);

    }

  }

}

module.exports = NarrativeModel;
