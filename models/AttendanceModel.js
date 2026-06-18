const db = require("../config/db");
const { sendNotification } = require("../services/notificationServices");

function getPHTime() {
  return new Date().toLocaleTimeString("en-CA", {
    timeZone: "Asia/Manila",
    hour12: false
  });
}

class AttendanceModel {

  // =========================
  // ACTIVE ATTENDANCE
  // =========================
  static async getActiveAttendance(
    student_id,
    academic_year_id
  ) {

    const [[row]] = await db.query(`
    SELECT *
    FROM attendance
    WHERE student_id = ?
    AND academic_year_id = ?
    AND attendance_date = CURDATE()
    AND (
      time_out IS NULL
      OR (
        time_out IS NOT NULL
        AND ot_time_in IS NOT NULL
        AND ot_time_out IS NULL
      )
    )
    ORDER BY attendance_id DESC
    LIMIT 1
  `, [
      student_id,
      academic_year_id
    ]);

    return row || null;
  }
  // =========================
  // STUDENT ATTENDANCE
  // =========================
  static async getByStudent(
    student_id,
    academic_year_id
  ) {

    const [rows] = await db.query(`
      SELECT 
        attendance_id,
        student_id,
        attendance_date,

        time_in,
        lunch_break_start,
        lunch_break_end,
        time_out,

        ot_time_in,
        ot_time_out,

        latitude,
        longitude,

        location_status,
        coordinator_note,
        created_at

      FROM attendance

      WHERE student_id = ?
      AND academic_year_id = ?

      ORDER BY attendance_date DESC,
               attendance_id DESC
    `, [
      student_id,
      academic_year_id
    ]);

    return rows;
  }

  // =========================
  // BY DEPARTMENT
  // =========================
  static async getByDepartment(department_id, academic_year_id) {

    let sql = `
      SELECT
        a.attendance_id,
        a.student_id,
        a.attendance_date,

        a.time_in,
        a.lunch_break_start,
        a.lunch_break_end,
        a.time_out,

        a.ot_time_in,
        a.ot_time_out,

        a.latitude,
        a.longitude,

        a.location_status,
        a.coordinator_note,

        u.f_name,
        u.l_name,
        u.photo,

        s.start_time,
        s.end_time

      FROM attendance a

      JOIN students s
        ON a.student_id = s.student_id

      JOIN users u
        ON s.user_id = u.user_id

      JOIN courses c
        ON s.course_id = c.course_id
    `;

    if (department_id) {

      sql += `
        WHERE c.department_id = ?
        AND a.academic_year_id = ?
      `;

      return (await db.query(sql, [department_id, academic_year_id]))[0];
    }

    sql += `
    WHERE a.academic_year_id = ?
  `;

    return (
      await db.query(
        sql,
        [academic_year_id]
      )
    )[0];
  }

  // =========================
  // CHECK IF LUNCH REQUIRED
  // =========================
  static async requiresLunch(student_id) {

    const [[student]] = await db.query(`
      SELECT start_time, end_time
      FROM students
      WHERE student_id = ?
      LIMIT 1
    `, [student_id]);

    if (!student?.start_time || !student?.end_time) {
      return true;
    }

    const [hoursRow] = await db.query(`
      SELECT
        (
          TIME_TO_SEC(
            TIMEDIFF(
              ?,
              ?
            )
          ) / 3600
        ) AS shift_hours
    `, [
      student.end_time,
      student.start_time
    ]);

    let shiftHours = Number(hoursRow?.[0]?.shift_hours || 0);

    // night shift correction
    if (shiftHours < 0) {
      shiftHours += 24;
    }

    return shiftHours >= 5;
  }

  // =========================
  // TIME IN / START OT
  // =========================
  static async timeIn({
    student_id,
    academic_year_id,
    latitude,
    longitude,
    early_reason,
    early_attachment_url,
    early_attachment_public_id,
    early_attachment_name
  }) {

    const now = getPHTime();

    const active =
      await this.getActiveAttendance(
        student_id,
        academic_year_id
      );

    // =========================
    // LOCATION CHECK
    // =========================
    let location_status = "flagged";

    if (
      latitude !== undefined &&
      longitude !== undefined
    ) {

      const [[location]] = await db.query(`
        SELECT latitude, longitude, radius_meters
        FROM students s
        JOIN ojt_locations l
          ON s.company_id = l.company_id
        WHERE s.student_id = ?
        LIMIT 1
      `, [student_id]);

      if (location) {

        const [[distanceResult]] = await db.query(`
          SELECT (
            6371000 * ACOS(
              COS(RADIANS(?)) *
              COS(RADIANS(?)) *
              COS(RADIANS(?) - RADIANS(?)) +
              SIN(RADIANS(?)) *
              SIN(RADIANS(?))
            )
          ) AS distance
        `, [
          latitude,
          location.latitude,
          location.longitude,
          longitude,
          latitude,
          location.latitude
        ]);

        if ((distanceResult.distance || 999999)
          <= location.radius_meters) {

          location_status = "verified";
        }
      }
    }

    // =========================
    // EARLY ATTENDANCE CHECK (only for first time in)
    // =========================
    let early_attendance = false;
    let early_status = null;
    let early_reason_to_store = null;

    if (!active) {
      const [[student]] = await db.query(`
    SELECT start_time
    FROM students
    WHERE student_id = ?
    LIMIT 1
  `, [student_id]);

      const EARLY_THRESHOLD_MINUTES = 15;

      if (student?.start_time) {
        const toMinutes = (time) => {
          const [h, m] = time.split(":").map(Number);
          return h * 60 + m;
        };

        const scheduleMinutes = toMinutes(student.start_time);
        const currentMinutes = toMinutes(now);

        const diffMinutes = currentMinutes - scheduleMinutes;

        if (diffMinutes < -EARLY_THRESHOLD_MINUTES) {
          if (!early_reason) {
            throw new Error("Reason is required for early attendance.");
          }
          early_attendance = true;
          early_status = "pending";
          early_reason_to_store = early_reason;
        }
      }
    }

    // =========================
    // FIRST TIME IN
    // =========================
    if (!active) {

      const [result] = await db.query(`
    INSERT INTO attendance (
      student_id,
      academic_year_id,
      attendance_date,
      time_in,
      latitude,
      longitude,
      location_status,
      early_attendance,
      early_reason,
      early_status,
      early_attachment_url,
      early_attachment_public_id,
      early_attachment_name
    )
    VALUES (?, ?, CURDATE(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
        student_id,
        academic_year_id,
        now,
        latitude ?? null,
        longitude ?? null,
        location_status,
        early_attendance,
        early_reason_to_store,
        early_status,
        early_attachment_url ?? null,
        early_attachment_public_id ?? null,
        early_attachment_name ?? null
      ]);

// =========================
// NOTIFY COORDINATOR IF EARLY
// =========================
if (early_attendance) {
  try {
    const [[studentInfo]] = await db.query(`
      SELECT
        u.f_name,
        u.l_name,
        s.start_time,
        cu.user_id AS coordinator_user_id
      FROM students s
      JOIN users u ON s.user_id = u.user_id
      JOIN coordinators c ON s.department_id = c.department_id
      JOIN users cu ON c.user_id = cu.user_id
      WHERE s.student_id = ?
      LIMIT 1
    `, [student_id]);

    if (studentInfo?.coordinator_user_id) {
      const formatTime = (timeStr) => {
        if (!timeStr) return "N/A";
        const [h, m] = timeStr.split(":").map(Number);
        const period = h >= 12 ? "PM" : "AM";
        const hour = h % 12 || 12;
        return `${hour}:${String(m).padStart(2, "0")} ${period}`;
      };

      const fullName = `${studentInfo.f_name} ${studentInfo.l_name}`;
      const timeInFormatted = formatTime(now);
      const scheduledFormatted = formatTime(studentInfo.start_time);

      await sendNotification({
        user_id: studentInfo.coordinator_user_id,
        title: "Early Attendance Request",
        message: `${fullName} submitted an early attendance request.\nTime In: ${timeInFormatted}\nScheduled Start: ${scheduledFormatted}`,
        type: "system",
        link: "/coordinator/attendance",
        academic_year_id
      });
    }
  } catch (error) {
    console.error("Early attendance notification failed:", error);
  }
}

      return result.insertId;
    }

    // =========================
    // BLOCK DUPLICATE TIME IN
    // =========================
    if (active.time_in && !active.time_out) {
      throw new Error("Already timed in");
    }

    // =========================
    // START OT
    // =========================
    if (
      active.time_out &&
      !active.ot_time_in
    ) {

      await db.query(`
        UPDATE attendance
        SET ot_time_in = ?
        WHERE attendance_id = ?
      `, [
        now,
        active.attendance_id
      ]);

      return;
    }

    // =========================
    // BLOCK DUPLICATE OT
    // =========================
    if (
      active.ot_time_in &&
      !active.ot_time_out
    ) {
      throw new Error("OT already started");
    }

    throw new Error("Attendance already completed");
  }

  // =========================
  // START LUNCH
  // =========================
  static async startLunchBreak(
    student_id,
    academic_year_id
  ) {

    const now = getPHTime();

    const active =
      await this.getActiveAttendance(
        student_id,
        academic_year_id
      );

    if (!active) {
      throw new Error("No active attendance");
    }

    if (!active.time_in) {
      throw new Error("Time in first");
    }

    if (active.time_out) {
      throw new Error("Already timed out");
    }

    const requiresLunch =
      await this.requiresLunch(student_id);

    if (!requiresLunch) {
      throw new Error(
        "Lunch break not required for this shift"
      );
    }

    if (active.lunch_break_start) {
      throw new Error(
        "Lunch break already started"
      );
    }

    await db.query(`
      UPDATE attendance
      SET lunch_break_start = ?
      WHERE attendance_id = ?
    `, [
      now,
      active.attendance_id
    ]);
  }

  // =========================
  // END LUNCH
  // =========================
  static async endLunchBreak(
    student_id,
    academic_year_id
  ) {

    const now = getPHTime();

    const active =
      await this.getActiveAttendance(
        student_id,
        academic_year_id
      );

    if (!active) {
      throw new Error("No active attendance");
    }

    if (!active.lunch_break_start) {
      throw new Error(
        "Lunch break not started"
      );
    }

    if (active.lunch_break_end) {
      throw new Error(
        "Lunch break already ended"
      );
    }

    await db.query(`
      UPDATE attendance
      SET lunch_break_end = ?
      WHERE attendance_id = ?
    `, [
      now,
      active.attendance_id
    ]);
  }

  // =========================
  // TIME OUT / END OT
  // =========================
  static async timeOutByStudent(
    student_id,
    academic_year_id
  ) {

    const now = getPHTime();

    const active =
      await this.getActiveAttendance(
        student_id,
        academic_year_id
      );

    if (!active) {
      throw new Error("No active attendance");
    }

    // =========================
    // REGULAR TIME OUT
    // =========================
    if (
      active.time_in &&
      !active.time_out
    ) {

      await db.query(`
        UPDATE attendance
        SET time_out = ?
        WHERE attendance_id = ?
      `, [
        now,
        active.attendance_id
      ]);

      await this.checkCompletionAndNotify(
        student_id,
        academic_year_id
      );

      return;
    }

    // =========================
    // END OT
    // =========================
    if (
      active.ot_time_in &&
      !active.ot_time_out
    ) {

      await db.query(`
        UPDATE attendance
        SET ot_time_out = ?
        WHERE attendance_id = ?
      `, [
        now,
        active.attendance_id
      ]);

      await this.checkCompletionAndNotify(
        student_id,
        academic_year_id
      );

      return;
    }

    throw new Error(
      "Attendance already completed"
    );
  }

  // =========================
  // HOURS COMPUTATION
  // =========================
  static async getHoursByStudent(student_id, academic_year_id) {

    const [[row]] = await db.query(`
      SELECT
        IFNULL(
          SUM(
            (
              (
                IFNULL(
                  TIME_TO_SEC(
                    TIMEDIFF(time_out, time_in)
                  ),
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
                          TIMEDIFF(
                            time_out,
                            time_in
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
                      ot_time_out,
                      ot_time_in
                    )
                  ),
                  0
                )
            ) / 3600
          ),
          0
        ) AS hours

      FROM attendance

      WHERE student_id = ?
      AND academic_year_id = ?
      AND time_in IS NOT NULL
      AND time_out IS NOT NULL
      AND location_status = 'verified'
    `, [student_id, academic_year_id]);

    return row.hours || 0;
  }

  // =========================
  // COMPLETION CHECK
  // =========================
  static async checkCompletionAndNotify(
    student_id,
    academic_year_id
  ) {

    const [[row]] = await db.query(`
      SELECT
        s.user_id,

        s.ojt_hours_required
          AS required_hours,

        IFNULL(
          SUM(
            (
              (
                IFNULL(
                  TIME_TO_SEC(
                    TIMEDIFF(
                      a.time_out,
                      a.time_in
                    )
                  ),
                  0
                )

                - IF(
                    a.lunch_break_start
                      IS NOT NULL
                    AND
                    a.lunch_break_end
                      IS NOT NULL,

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
        ) AS completed_hours

      FROM students s

      LEFT JOIN attendance a
        ON s.student_id = a.student_id
        AND a.location_status = 'verified'
        AND a.academic_year_id = ?

      WHERE s.student_id = ?

      GROUP BY
        s.user_id,
        s.ojt_hours_required
    `, [
      academic_year_id,
      student_id
    ]);

    if (!row) return;

    if (
      row.completed_hours
      < row.required_hours
    ) {
      return;
    }

    const [[existing]] = await db.query(`
      SELECT notif_id
      FROM notifications
      WHERE user_id = ?
      AND title = 'OJT Completed'
      LIMIT 1
    `, [row.user_id]);

    if (existing) return;

    await sendNotification({
      user_id: row.user_id,
      title: "OJT Completed",
      message:
        "Congratulations! You have completed your required OJT hours.",
      type: "system",
      link: "/student/progress",
      academic_year_id
    });
  }

  // =========================
  // TODAY
  // =========================
  static async getToday(student_id, academic_year_id) {
    const active = await this.getActiveAttendance(student_id, academic_year_id);

    if (active) {
      const [[student]] = await db.query(`
      SELECT start_time, end_time
      FROM students
      WHERE student_id = ?
      LIMIT 1
    `, [student_id]);

      return {
        ...active,
        start_time: student?.start_time || null,
        end_time: student?.end_time || null
      };
    }

    const [rows] = await db.query(`
    SELECT
      a.attendance_id,
      a.attendance_date,

      a.time_in,
      a.lunch_break_start,
      a.lunch_break_end,
      a.time_out,

      a.ot_time_in,
      a.ot_time_out,

      a.early_attendance,
      a.early_reason,
      a.early_status,
      a.early_attachment_url,
      a.early_attachment_name,

      s.start_time,
      s.end_time

    FROM attendance a

    JOIN students s
      ON a.student_id = s.student_id

    WHERE a.student_id = ?
    AND a.academic_year_id = ?
    AND a.attendance_date = CURDATE()

    ORDER BY a.attendance_id DESC
    LIMIT 1
  `, [student_id, academic_year_id]);

    return rows[0] || null;
  }

  // =========================
  // HISTORY
  // =========================
  static async getStudentHistory(student_id, academic_year_id) {

    const [rows] = await db.query(`
    SELECT
      a.attendance_id,
      a.attendance_date,

      a.time_in,
      a.lunch_break_start,
      a.lunch_break_end,
      a.time_out,

      a.ot_time_in,
      a.ot_time_out,

      a.early_attendance,
      a.early_reason,
      a.early_status,
      a.early_attachment_url,
      a.early_attachment_name,

      s.start_time,
      s.end_time

    FROM attendance a

    JOIN students s
      ON a.student_id = s.student_id

    WHERE a.student_id = ?
    AND a.academic_year_id = ?

    ORDER BY
      a.attendance_date DESC,
      a.attendance_id DESC
  `, [student_id, academic_year_id]);

    return rows;
  }

  // =========================
  // UPDATE LOCATION STATUS
  // =========================
  static async updateLocationStatus(
    attendance_id,
    location_status
  ) {

    const [result] = await db.query(`
      UPDATE attendance
      SET location_status = ?
      WHERE attendance_id = ?
    `, [
      location_status,
      attendance_id
    ]);

    console.log(
      "Rows affected:",
      result.affectedRows
    );
  }
  // =========================
  // COORDINATOR: STUDENT RECORDS
  // =========================
  static async getStudentAttendanceRecords(student_id, academic_year_id) {

    const [rows] = await db.query(`
    SELECT
      a.attendance_id,
      a.student_id,
      a.attendance_date,

      a.time_in,
      a.lunch_break_start,
      a.lunch_break_end,
      a.time_out,

      a.ot_time_in,
      a.ot_time_out,

      a.latitude,
      a.longitude,

      a.location_status,
      a.coordinator_note,

      a.early_attendance,
      a.early_reason,
      a.early_status,
      a.early_attachment_url,
      a.early_attachment_name,

      u.f_name,
      u.l_name,
      u.photo,

      s.start_time,
      s.end_time

    FROM attendance a

    JOIN students s
      ON a.student_id = s.student_id

    JOIN users u
      ON s.user_id = u.user_id

    WHERE a.student_id = ?
    AND a.academic_year_id = ?

    ORDER BY
      a.attendance_date DESC,
      a.attendance_id DESC
  `, [student_id, academic_year_id]);

    return rows;
  }

  // =========================
  // EARLY ATTENDANCE COORDINATOR METHODS
  // =========================
  static async approveEarlyAttendance(
    attendance_id,
    academic_year_id
  ) {
    await db.query(`
      UPDATE attendance
      SET early_status = 'approved'
      WHERE attendance_id = ?
      AND academic_year_id = ?
    `, [attendance_id, academic_year_id]);

    return { success: true };
  }

  static async rejectEarlyAttendance(
    attendance_id,
    academic_year_id
  ) {
    await db.query(`
      UPDATE attendance
      SET early_status = 'rejected'
      WHERE attendance_id = ?
      AND academic_year_id = ?
    `, [attendance_id, academic_year_id]);

    return { success: true };
  }

  static async getPendingEarlyAttendance(
  academic_year_id,
  department_id
) {
  const [rows] = await db.query(`
    SELECT 
      a.attendance_id,
      a.student_id,
      a.attendance_date,
      a.time_in,
      a.early_reason,
      a.early_status,
      a.early_attachment_url,
      a.early_attachment_name,
      s.start_time,
      s.end_time,
      u.f_name,
      u.l_name,
      u.photo
    FROM attendance a
    JOIN students s 
      ON a.student_id = s.student_id
    JOIN users u 
      ON s.user_id = u.user_id
    WHERE a.early_attendance = 1
      AND a.early_status = 'pending'
      AND a.academic_year_id = ?
      AND s.department_id = ?
    ORDER BY a.attendance_id DESC
    `, [academic_year_id, department_id]);

    return rows;
  }
}

module.exports = AttendanceModel;