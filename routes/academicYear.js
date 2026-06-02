const express = require("express");
const router = express.Router();

const ctrl = require(
  "../controllers/academicYearController"
);

router.get("/", ctrl.getAll);

router.get("/active", ctrl.getActive);

router.post("/", ctrl.create);

router.put("/:id/activate", ctrl.setActive);

module.exports = router;