const express = require("express");
const router = express.Router();
const ctrl = require("../controllers/evaluationTemplateController");


// ================= ADMIN =================
router.get("/admin", ctrl.listAdminTemplates);


// ================= COORDINATOR =================
router.get("/", ctrl.listCoordinatorTemplates);


// ================= USE TEMPLATE =================
router.post("/use/:templateId", ctrl.useTemplate);


// ================= BUILDER =================
router.get("/builder/:templateId", ctrl.getBuilder);
router.put("/builder/:templateId", ctrl.saveBuilder);


// ================= PUBLISH TEMPLATE =================
router.put("/:id/publish", ctrl.publishTemplate);


// ================= TEMPLATE CRUD =================
router.get("/:id", ctrl.getTemplate);
router.post("/", ctrl.createTemplate);
router.put("/:id", ctrl.updateTemplate);
router.delete("/:id", ctrl.deleteTemplate);


module.exports = router;