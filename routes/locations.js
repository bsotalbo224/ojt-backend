const express = require("express");
const router = express.Router();
const { requireAuth } = require("../middleware/authMiddleware");
const { requireRole } = require("../middleware/roleMiddleware");
const LocationModel = require("../models/LocationModel");

/* =====================================================
GET LOCATIONS BY COMPANY
===================================================== */
router.get("/company/:company_id", requireAuth, async (req, res) => {
  try {
    const data = await LocationModel.getLocationsByCompany(
      req.params.company_id
    );
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

/* =====================================================
GET SINGLE
===================================================== */
router.get("/:id", requireAuth, async (req, res) => {
  try {
    const data = await LocationModel.getLocationById(req.params.id);
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

/* =====================================================
CREATE
===================================================== */
router.post("/", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const data = await LocationModel.createLocation(req.body);
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

/* =====================================================
UPDATE
===================================================== */
router.put("/:id", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const data = await LocationModel.updateLocation(
      req.params.id,
      req.body
    );
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

/* =====================================================
DELETE
===================================================== */
router.delete("/:id", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const data = await LocationModel.deleteLocation(req.params.id);
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
