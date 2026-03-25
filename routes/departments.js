const express = require("express");
const router = express.Router();

const DepartmentModel = require("../models/DepartmentModel");
const { requireAuth } = require("../middleware/authMiddleware");
const { requireRole } = require("../middleware/roleMiddleware");
const upload = require("../middleware/uploadMiddleware");
const db = require("../config/db");
const cloudinary = require("../config/cloudinary");

// Protect all routes
router.use(requireAuth);

/* ===================================================
ADMIN: ALL DEPARTMENTS
=================================================== */
router.get("/", requireRole("admin"), async (req, res) => {
  try {
    const data = await DepartmentModel.getAll();
    res.json(data);
  } catch (err) {
    console.error("GET DEPARTMENTS ERROR:", err);
    res.status(500).json({ message: "Server error" });
  }
});

/* ===================================================
ADMIN: DEPARTMENTS (WITH THEME ONLY)
=================================================== */
router.get("/theme-list", requireRole("admin"), async (req, res) => {
  try {
    const data = await DepartmentModel.getAllWithTheme();

    res.json({
      success: true,
      departments: data
    });
  } catch (err) {
    console.error("GET THEME DEPARTMENTS ERROR:", err);
    res.status(500).json({ message: "Server error" });
  }
});

/* ===================================================
ADMIN: UPDATE DEPARTMENT THEME
=================================================== */
router.put("/theme", requireRole("admin"), async (req, res) => {
  try {
    const { department_id, theme } = req.body;

    if (!department_id || !theme) {
      return res.status(400).json({
        success: false,
        message: "Department and theme are required"
      });
    }

    await DepartmentModel.updateTheme(department_id, theme);

    res.json({
      success: true,
      message: "Theme updated successfully"
    });

  } catch (err) {
    console.error("UPDATE THEME ERROR:", err);
    res.status(500).json({ message: "Server error" });
  }
});

/* ===================================================
ADMIN: CREATE DEPARTMENT
=================================================== */
router.post("/", requireRole("admin"), async (req, res) => {
  try {
    const id = await DepartmentModel.create(req.body);
    res.json({ department_id: id });
  } catch (err) {
    console.error("CREATE DEPARTMENT ERROR:", err);
    res.status(500).json({ message: "Server error" });
  }
});

/* ===================================================
ADMIN: UPLOAD DEPARTMENT LOGO (CLOUDINARY)
=================================================== */
router.post(
  "/upload-logo",
  requireRole("admin"),
  upload.single("logo"),
  async (req, res) => {
    try {
      const { department_id } = req.body;

      if (!department_id || !req.file) {
        return res.status(400).json({
          success: false,
          message: "Department ID and logo file are required",
        });
      }


      const [[existing]] = await db.query(
        "SELECT logo FROM departments WHERE department_id = ?",
        [department_id]
      );

      if (existing?.logo && existing.logo.startsWith("http")) {
        try {
          const parts = existing.logo.split("/");
          const fileName = parts[parts.length - 1];
          const publicId = `ojt-system/departments/${fileName.split(".")[0]}`;

          await cloudinary.uploader.destroy(publicId);
        } catch (err) {
          console.warn("Old logo deletion skipped:", err.message);
        }
      }


      const logoUrl = req.file.path;

      await DepartmentModel.updateLogo(department_id, logoUrl);

      res.json({
        success: true,
        logo: logoUrl,
      });

    } catch (err) {
      console.error("UPLOAD LOGO ERROR:", err);
      res.status(500).json({ message: "Server error" });
    }
  }
);

/* ===================================================
ADMIN: UPDATE DEPARTMENT
=================================================== */
router.put("/:id", requireRole("admin"), async (req, res) => {
  try {
    await DepartmentModel.update(req.params.id, req.body);
    res.json({ success: true });
  } catch (err) {
    console.error("UPDATE DEPARTMENT ERROR:", err);
    res.status(500).json({ message: "Server error" });
  }
});

/* ===================================================
ADMIN: DELETE DEPARTMENT
=================================================== */
router.delete("/:id", requireRole("admin"), async (req, res) => {
  try {
    await DepartmentModel.delete(req.params.id);
    res.json({ success: true });
  } catch (err) {
    console.error("DELETE DEPARTMENT ERROR:", err);
    res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;