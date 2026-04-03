const express = require("express");
const router = express.Router();

const CourseModel = require("../models/CourseModel");

const { requireAuth } = require("../middleware/authMiddleware");
const { requireRole } = require("../middleware/roleMiddleware");

router.use(requireAuth);
router.use(requireRole("admin", "coordinator"));

/* =====================================================
COURSE CODE GENERATOR
===================================================== */
const generateCourseCode = (name) => {
  if (!name) return "";

  const words = name.trim().split(/\s+/);

  // Handle Bachelor courses like "BS Information Technology"
  if (words[0].toUpperCase() === "BS") {
    const rest = words.slice(1);

    const code =
      "BS" +
      rest
        .map((w) => w[0].toUpperCase())
        .join("");

    return code.substring(0, 10);
  }

  // fallback (first letters of words)
  return words
    .map((w) => w[0].toUpperCase())
    .join("")
    .substring(0, 10);
};

/* =====================================================
GET ALL COURSES
===================================================== */
router.get("/", async (req, res) => {
  try {
    const courses = await CourseModel.getAll();
    res.json(courses);
  } catch (err) {
    console.error("GET COURSES ERROR:", err);
    res.status(500).json({ message: "Server error" });
  }
});

/* =====================================================
CREATE COURSE
===================================================== */
router.post("/", async (req, res) => {
  try {
    const { course_name, department_id } = req.body;

    if (!course_name || !department_id) {
      return res.status(400).json({
        message: "Course name and department required",
      });
    }

    const course_code = generateCourseCode(course_name);

    const course_id = await CourseModel.create({
      course_code,
      course_name,
      department_id,
    });

    res.json({
      course_id,
      course_code,
      course_name,
      department_id,
    });
  } catch (err) {
    console.error("CREATE COURSE ERROR:", err);
    res.status(500).json({ message: "Server error" });
  }
});

/* =====================================================
UPDATE COURSE
===================================================== */
router.put("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { course_name, department_id } = req.body;

    if (!course_name || !department_id) {
      return res.status(400).json({
        message: "Course name and department required",
      });
    }

    const course_code = generateCourseCode(course_name);

    await CourseModel.update(id, {
      course_code,
      course_name,
      department_id,
    });

    res.json({
      course_id: id,
      course_code,
      course_name,
      department_id,
    });
  } catch (err) {
    console.error("UPDATE COURSE ERROR:", err);
    res.status(500).json({ message: "Server error" });
  }
});

/* =====================================================
DELETE COURSE
===================================================== */
router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    await CourseModel.delete(id);

    res.json({ success: true });
  } catch (err) {
    console.error("DELETE COURSE ERROR:", err);
    res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;