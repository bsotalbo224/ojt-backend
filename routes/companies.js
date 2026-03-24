const express = require("express");
const router = express.Router();
const { requireAuth } = require("../middleware/authMiddleware");
const { requireRole } = require("../middleware/roleMiddleware");
const CompanyModel = require("../models/CompanyModel");

/* GET ALL */
router.get("/", requireAuth, async (req, res) => {
  try {
    const data = await CompanyModel.getAllCompanies();
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

/* SUMMARY */
router.get("/summary", requireAuth, async (req, res) => {
  try {
    const data = await CompanyModel.getCompaniesSummary();
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

/* CREATE */
router.post("/", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const data = await CompanyModel.createCompany(req.body);
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

/* UPDATE */
router.put("/:id", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const data = await CompanyModel.updateCompany(req.params.id, req.body);
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

/* STATUS */
router.patch("/:id/status", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const data = await CompanyModel.toggleCompanyStatus(
      req.params.id,
      req.body.is_active
    );
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

/* DELETE */
router.delete("/:id", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const data = await CompanyModel.deleteCompany(req.params.id);
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
