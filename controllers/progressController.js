const ProgressModel = require("../models/ProgressModel");

exports.getStudentProgress = async (req, res) => {
  const student_id = req.user.student_id;

  try {
    // FETCH CORE DATA
    const hours = await ProgressModel.getStudentHours(student_id);
    const narratives = await ProgressModel.getNarrativeStats(student_id);
    const dailyLogs = await ProgressModel.getDailyLogStats(student_id);
    const attendance = await ProgressModel.getAttendanceStats(student_id);

    if (!hours) return res.json(null);

    const required = hours.required_hours || 0;
    const completed = hours.completed_hours || 0;

    const completionPercent =
      required > 0
        ? Math.min(Math.round((completed / required) * 100), 100)
        : 0;

    // CHECKLIST LOGIC (evaluation postponed)
    const requiredHoursCompleted =
  Number(completed) >= Number(required) - 0.25;

    const dailyLogsComplete =
      Number(dailyLogs.total || 0) > 0 &&
      Number(dailyLogs.approved || 0) === (dailyLogs.total || 0);

    const narrativesApproved =
      Number(narratives.total || 0) > 0 &&
      Number(narratives.approved || 0) === (narratives.total || 0);

    const coordinatorVerified =
      requiredHoursCompleted &&
      dailyLogsComplete &&
      narrativesApproved;

    res.json({
      student_name: hours.student_name,
      department_name: hours.department_name,
      course_name: hours.course_name,
      coordinator_name: hours.coordinator_name,

      company_name: hours.company_name,
      required_hours: required,
      completed_hours: completed,
      remaining_hours: Math.max(required - completed, 0),

      completion_percent: completionPercent,

      attendance,

      dailyLogs,
      narratives,

      checklist: {
        requiredHoursCompleted,
        dailyLogsComplete,
        narrativesApproved,
        coordinatorVerified
      }
    });

  } catch (err) {
    console.error("Progress fetch error:", err);
    res.status(500).json({ error: "Failed to fetch progress" });
  }
};