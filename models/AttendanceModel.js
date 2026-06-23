const db = require("../config/db");
const { sendNotification } = require("../services/notificationServices");

function getPHTime() {
  return new Date().toLocaleTimeString("en-CA", {
    timeZone: "Asia/Manila",
    hour12: false
  });
}

// Safe numeric time comparison helper.
// Converts a "HH:MM" or "HH:MM:SS" string into total minutes so time
// values can be compared reliably instead of relying on string
// comparison (which breaks on inconsistent zero-padding/formats).
function toMinutes(time) {
  const [h, m] = String(time).split(":").map(Number);
  return h * 60 + m;
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
  // LEGACY / INTERNAL: returns raw attendance rows (no early-attendance
  // fields, no display_time_in, no student schedule join, no pagination).
  // Not called anywhere else in this file — not used by getStudentHistory()
  // or getStudentHistoryForExport(). Kept for backward compatibility with
  // any existing controller/route that may still call it directly. New
  // student-facing attendance history reads should use getStudentHistory()
  // (paginated) or getStudentHistoryForExport() (full, for PDF export)
  // instead, since those include the effective-time / early-attendance
  // display rules. Do not remove without confirming no external callers.
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
    // No threshold: ANY time_in earlier than start_time is early.
    // Shift-aware: night shifts (start_time >= 6 PM) roll over past
    // midnight, so a time_in in the early-morning hours (12:00 AM-11:59 AM)
    // belongs to the shift that already started the previous evening and
    // must NOT be flagged as early.
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

      if (student?.start_time) {
        const scheduleMinutes = toMinutes(student.start_time);
        const currentMinutes = toMinutes(now);

        // Night shift = scheduled start at or after 6:00 PM (18 * 60).
        const isNightShift = scheduleMinutes >= 18 * 60;

        let isEarly = false;

        if (isNightShift) {
          // For night shift:
          // 12:00 AM-11:59 AM belongs to next calendar day,
          // so it should NOT be treated as early.
          if (currentMinutes >= 0 && currentMinutes < 12 * 60) {
            isEarly = false;
          } else {
            isEarly = currentMinutes < scheduleMinutes;
          }
        } else {
          // Day shift
          isEarly = currentMinutes < scheduleMinutes;
        }

        // Any time_in earlier than start_time (even by 1 minute) is early.
        if (isEarly) {
          if (!early_reason) {
            throw new Error("Reason is required for early attendance.");
          }
          if (!early_attachment_url) {
            throw new Error("Attachment is required for early attendance.");
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
  // EFFECTIVE TIME RULE:
  //   - early_attendance = 1 AND early_status = 'approved'  -> use actual a.time_in
  //   - a.time_in earlier than s.start_time, accounting for night shifts
  //     (pending / rejected / any other state) -> use s.start_time
  //     Day shift:   start_time < 18:00 AND time_in < start_time
  //     Night shift: start_time >= 18:00 AND time_in >= 12:00 AND time_in < start_time
  //     (a night-shift time_in in the 12:00 AM-11:59 AM window is treated
  //     as a continuation of the previous evening's shift, NOT early)
  //   - otherwise -> use actual a.time_in
  // This guarantees early minutes are NEVER counted unless explicitly approved.
  //
  // OVERNIGHT-SAFE DURATIONS:
  //   Plain TIMEDIFF(end, start) goes negative whenever a shift, break, or
  //   OT session crosses midnight (e.g. time_in 22:00 -> time_out 06:00).
  //   Every duration below is wrapped in a CASE that detects end < start
  //   and adds 24:00:00 to "end" via ADDTIME before diffing, so work
  //   hours, lunch/meal breaks, and OT all compute correctly across
  //   midnight. Same-day durations are unaffected (CASE falls through
  //   to the original plain TIMEDIFF).
  static async getHoursByStudent(student_id, academic_year_id) {

    const [[row]] = await db.query(`
      SELECT
        IFNULL(
          SUM(
            (
              (
                IFNULL(
                  TIME_TO_SEC(
                    CASE
                      WHEN a.time_out < (
                        CASE
                          WHEN a.early_attendance = 1
                           AND a.early_status = 'approved'
                          THEN a.time_in
                          WHEN (
                            (
                              s.start_time < '18:00:00'
                              AND a.time_in < s.start_time
                            )
                            OR
                            (
                              s.start_time >= '18:00:00'
                              AND a.time_in >= '12:00:00'
                              AND a.time_in < s.start_time
                            )
                          )
                          THEN s.start_time
                          ELSE a.time_in
                        END
                      )
                      THEN TIMEDIFF(
                        ADDTIME(a.time_out, '24:00:00'),
                        CASE
                          WHEN a.early_attendance = 1
                           AND a.early_status = 'approved'
                          THEN a.time_in
                          WHEN (
                            (
                              s.start_time < '18:00:00'
                              AND a.time_in < s.start_time
                            )
                            OR
                            (
                              s.start_time >= '18:00:00'
                              AND a.time_in >= '12:00:00'
                              AND a.time_in < s.start_time
                            )
                          )
                          THEN s.start_time
                          ELSE a.time_in
                        END
                      )
                      ELSE TIMEDIFF(
                        a.time_out,
                        CASE
                          WHEN a.early_attendance = 1
                           AND a.early_status = 'approved'
                          THEN a.time_in
                          WHEN (
                            (
                              s.start_time < '18:00:00'
                              AND a.time_in < s.start_time
                            )
                            OR
                            (
                              s.start_time >= '18:00:00'
                              AND a.time_in >= '12:00:00'
                              AND a.time_in < s.start_time
                            )
                          )
                          THEN s.start_time
                          ELSE a.time_in
                        END
                      )
                    END
                  ),
                  0
                )

                - IF(
                    a.lunch_break_start IS NOT NULL
                    AND a.lunch_break_end IS NOT NULL,

                    TIME_TO_SEC(
                      CASE
                        WHEN a.lunch_break_end < a.lunch_break_start
                        THEN TIMEDIFF(
                          ADDTIME(a.lunch_break_end, '24:00:00'),
                          a.lunch_break_start
                        )
                        ELSE TIMEDIFF(
                          a.lunch_break_end,
                          a.lunch_break_start
                        )
                      END
                    ),

                    IF(
                      IFNULL(
                        TIME_TO_SEC(
                          CASE
                            WHEN a.time_out < (
                              CASE
                                WHEN a.early_attendance = 1
                                 AND a.early_status = 'approved'
                                THEN a.time_in
                                WHEN (
                                  (
                                    s.start_time < '18:00:00'
                                    AND a.time_in < s.start_time
                                  )
                                  OR
                                  (
                                    s.start_time >= '18:00:00'
                                    AND a.time_in >= '12:00:00'
                                    AND a.time_in < s.start_time
                                  )
                                )
                                THEN s.start_time
                                ELSE a.time_in
                              END
                            )
                            THEN TIMEDIFF(
                              ADDTIME(a.time_out, '24:00:00'),
                              CASE
                                WHEN a.early_attendance = 1
                                 AND a.early_status = 'approved'
                                THEN a.time_in
                                WHEN (
                                  (
                                    s.start_time < '18:00:00'
                                    AND a.time_in < s.start_time
                                  )
                                  OR
                                  (
                                    s.start_time >= '18:00:00'
                                    AND a.time_in >= '12:00:00'
                                    AND a.time_in < s.start_time
                                  )
                                )
                                THEN s.start_time
                                ELSE a.time_in
                              END
                            )
                            ELSE TIMEDIFF(
                              a.time_out,
                              CASE
                                WHEN a.early_attendance = 1
                                 AND a.early_status = 'approved'
                                THEN a.time_in
                                WHEN (
                                  (
                                    s.start_time < '18:00:00'
                                    AND a.time_in < s.start_time
                                  )
                                  OR
                                  (
                                    s.start_time >= '18:00:00'
                                    AND a.time_in >= '12:00:00'
                                    AND a.time_in < s.start_time
                                  )
                                )
                                THEN s.start_time
                                ELSE a.time_in
                              END
                            )
                          END
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
                    CASE
                      WHEN a.ot_time_out < a.ot_time_in
                      THEN TIMEDIFF(
                        ADDTIME(a.ot_time_out, '24:00:00'),
                        a.ot_time_in
                      )
                      ELSE TIMEDIFF(
                        a.ot_time_out,
                        a.ot_time_in
                      )
                    END
                  ),
                  0
                )
            ) / 3600
          ),
          0
        ) AS hours

      FROM attendance a

      JOIN students s
        ON a.student_id = s.student_id

      WHERE a.student_id = ?
      AND a.academic_year_id = ?
      AND a.time_in IS NOT NULL
      AND a.time_out IS NOT NULL
      AND a.location_status = 'verified'
    `, [student_id, academic_year_id]);

    return row.hours || 0;
  }

  // =========================
  // COMPLETION CHECK
  // =========================
  // Uses the same EFFECTIVE TIME RULE and overnight-safe duration logic
  // as getHoursByStudent() so OJT completion hours never include
  // unapproved early minutes and never break on night-shift students.
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
                    CASE
                      WHEN a.time_out < (
                        CASE
                          WHEN a.early_attendance = 1
                           AND a.early_status = 'approved'
                          THEN a.time_in
                          WHEN (
                            (
                              s.start_time < '18:00:00'
                              AND a.time_in < s.start_time
                            )
                            OR
                            (
                              s.start_time >= '18:00:00'
                              AND a.time_in >= '12:00:00'
                              AND a.time_in < s.start_time
                            )
                          )
                          THEN s.start_time
                          ELSE a.time_in
                        END
                      )
                      THEN TIMEDIFF(
                        ADDTIME(a.time_out, '24:00:00'),
                        CASE
                          WHEN a.early_attendance = 1
                           AND a.early_status = 'approved'
                          THEN a.time_in
                          WHEN (
                            (
                              s.start_time < '18:00:00'
                              AND a.time_in < s.start_time
                            )
                            OR
                            (
                              s.start_time >= '18:00:00'
                              AND a.time_in >= '12:00:00'
                              AND a.time_in < s.start_time
                            )
                          )
                          THEN s.start_time
                          ELSE a.time_in
                        END
                      )
                      ELSE TIMEDIFF(
                        a.time_out,
                        CASE
                          WHEN a.early_attendance = 1
                           AND a.early_status = 'approved'
                          THEN a.time_in
                          WHEN (
                            (
                              s.start_time < '18:00:00'
                              AND a.time_in < s.start_time
                            )
                            OR
                            (
                              s.start_time >= '18:00:00'
                              AND a.time_in >= '12:00:00'
                              AND a.time_in < s.start_time
                            )
                          )
                          THEN s.start_time
                          ELSE a.time_in
                        END
                      )
                    END
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
                      CASE
                        WHEN a.lunch_break_end < a.lunch_break_start
                        THEN TIMEDIFF(
                          ADDTIME(a.lunch_break_end, '24:00:00'),
                          a.lunch_break_start
                        )
                        ELSE TIMEDIFF(
                          a.lunch_break_end,
                          a.lunch_break_start
                        )
                      END
                    ),

                    IF(
                      IFNULL(
                        TIME_TO_SEC(
                          CASE
                            WHEN a.time_out < (
                              CASE
                                WHEN a.early_attendance = 1
                                 AND a.early_status = 'approved'
                                THEN a.time_in
                                WHEN (
                                  (
                                    s.start_time < '18:00:00'
                                    AND a.time_in < s.start_time
                                  )
                                  OR
                                  (
                                    s.start_time >= '18:00:00'
                                    AND a.time_in >= '12:00:00'
                                    AND a.time_in < s.start_time
                                  )
                                )
                                THEN s.start_time
                                ELSE a.time_in
                              END
                            )
                            THEN TIMEDIFF(
                              ADDTIME(a.time_out, '24:00:00'),
                              CASE
                                WHEN a.early_attendance = 1
                                 AND a.early_status = 'approved'
                                THEN a.time_in
                                WHEN (
                                  (
                                    s.start_time < '18:00:00'
                                    AND a.time_in < s.start_time
                                  )
                                  OR
                                  (
                                    s.start_time >= '18:00:00'
                                    AND a.time_in >= '12:00:00'
                                    AND a.time_in < s.start_time
                                  )
                                )
                                THEN s.start_time
                                ELSE a.time_in
                              END
                            )
                            ELSE TIMEDIFF(
                              a.time_out,
                              CASE
                                WHEN a.early_attendance = 1
                                 AND a.early_status = 'approved'
                                THEN a.time_in
                                WHEN (
                                  (
                                    s.start_time < '18:00:00'
                                    AND a.time_in < s.start_time
                                  )
                                  OR
                                  (
                                    s.start_time >= '18:00:00'
                                    AND a.time_in >= '12:00:00'
                                    AND a.time_in < s.start_time
                                  )
                                )
                                THEN s.start_time
                                ELSE a.time_in
                              END
                            )
                          END
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
                    CASE
                      WHEN a.ot_time_out < a.ot_time_in
                      THEN TIMEDIFF(
                        ADDTIME(a.ot_time_out, '24:00:00'),
                        a.ot_time_in
                      )
                      ELSE TIMEDIFF(
                        a.ot_time_out,
                        a.ot_time_in
                      )
                    END
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
      AND academic_year_id = ?
      LIMIT 1
    `, [row.user_id, academic_year_id]);

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
  // display_time_in follows the EFFECTIVE TIME RULE:
  //   approved -> actual time_in
  //   pending / rejected (time_in earlier than start_time) -> start_time
  //   otherwise -> actual time_in
  static async getToday(student_id, academic_year_id) {
    const active = await this.getActiveAttendance(student_id, academic_year_id);

    if (active) {
      const [[student]] = await db.query(`
      SELECT start_time, end_time
      FROM students
      WHERE student_id = ?
      LIMIT 1
    `, [student_id]);

      const isApproved =
        active.early_attendance &&
        active.early_status === "approved";

      let isEarlierThanStart = false;

      if (student?.start_time && active.time_in) {
        const startMinutes = toMinutes(student.start_time);
        const timeInMinutes = toMinutes(active.time_in);

        const isNightShift = startMinutes >= 18 * 60;

        if (isNightShift) {
          // Night shift:
          // 12:00 AM-11:59 AM belongs to next calendar day
          // and should NOT be treated as early
          if (
            timeInMinutes >= 12 * 60 &&
            timeInMinutes < startMinutes
          ) {
            isEarlierThanStart = true;
          }
        } else {
          // Day shift
          if (timeInMinutes < startMinutes) {
            isEarlierThanStart = true;
          }
        }
      }

      const display_time_in =
        isApproved
          ? active.time_in
          : isEarlierThanStart
            ? student.start_time
            : active.time_in;

      return {
        ...active,
        start_time: student?.start_time || null,
        end_time: student?.end_time || null,
        display_time_in
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

      CASE
        WHEN a.early_attendance = 1
         AND a.early_status = 'approved'
        THEN a.time_in
        WHEN (
          (
            s.start_time < '18:00:00'
            AND a.time_in < s.start_time
          )
          OR
          (
            s.start_time >= '18:00:00'
            AND a.time_in >= '12:00:00'
            AND a.time_in < s.start_time
          )
        )
        THEN s.start_time
        ELSE a.time_in
      END AS display_time_in,

      s.start_time,
      s.end_time

    FROM attendance a

    JOIN students s
      ON a.student_id = s.student_id

    WHERE a.student_id = ?
    AND a.academic_year_id = ?

    ORDER BY a.attendance_id DESC
    LIMIT 1
  `, [student_id, academic_year_id]);

    return rows[0] || null;
  }

  // =========================
  // HISTORY (PAGINATED)
  // =========================
  // display_time_in follows the same EFFECTIVE TIME RULE as getToday().
  // Supports backend pagination (page + limit) for infinite scroll /
  // performant list rendering. Use getStudentHistoryForExport() when
  // the FULL unpaginated history is required (e.g. PDF export).
  static async getStudentHistory(
    student_id,
    academic_year_id,
    page = 1,
    limit = 15
  ) {

    const safePage = Math.max(Number(page) || 1, 1);
    const safeLimit = Math.min(
      Math.max(Number(limit) || 15, 1),
      100
    );
    const offset = (safePage - 1) * safeLimit;

    const [[countRow]] = await db.query(`
      SELECT COUNT(*) AS total
      FROM attendance
      WHERE student_id = ?
      AND academic_year_id = ?
    `, [student_id, academic_year_id]);

    const total = countRow?.total || 0;

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

      CASE
        WHEN a.early_attendance = 1
         AND a.early_status = 'approved'
        THEN a.time_in
        WHEN (
          (
            s.start_time < '18:00:00'
            AND a.time_in < s.start_time
          )
          OR
          (
            s.start_time >= '18:00:00'
            AND a.time_in >= '12:00:00'
            AND a.time_in < s.start_time
          )
        )
        THEN s.start_time
        ELSE a.time_in
      END AS display_time_in,

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
    LIMIT ? OFFSET ?
  `, [student_id, academic_year_id, safeLimit, offset]);

    return {
      data: rows,
      pagination: {
        page: safePage,
        limit: safeLimit,
        total,
        totalPages: Math.max(1, Math.ceil(total / safeLimit)),
        hasMore: safePage * safeLimit < total
      }
    };
  }

  // =========================
  // HISTORY (FULL, UNPAGINATED — FOR EXPORT)
  // =========================
  // Same SELECT, display_time_in logic, and sorting as getStudentHistory(),
  // but returns ALL rows with no LIMIT/OFFSET. Used by PDF export so the
  // exported document always contains the complete attendance record.
  static async getStudentHistoryForExport(student_id, academic_year_id) {

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

      CASE
        WHEN a.early_attendance = 1
         AND a.early_status = 'approved'
        THEN a.time_in
        WHEN (
          (
            s.start_time < '18:00:00'
            AND a.time_in < s.start_time
          )
          OR
          (
            s.start_time >= '18:00:00'
            AND a.time_in >= '12:00:00'
            AND a.time_in < s.start_time
          )
        )
        THEN s.start_time
        ELSE a.time_in
      END AS display_time_in,

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
  // Coordinator/Admin view: always returns raw, real attendance data
  // (actual time_in and full early-request details). Not modified
  // by the display/effective-time rules above.
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