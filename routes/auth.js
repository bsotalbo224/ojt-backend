const express = require("express");
const router = express.Router();
const db = require("../config/db");
const authController = require("../controllers/authController");
const uploadProfile = require("../middleware/uploadProfile");
const { requireAuth } = require("../middleware/authMiddleware");

/* ===============================
   AUTH ROUTES
=============================== */

router.post("/register", authController.register);
router.post("/login", authController.login);


/* ===============================
   GET CURRENT USER
=============================== */

router.get("/me", requireAuth, authController.getMe);

/* ===============================
   FIRST LOGIN PASSWORD CHANGE
=============================== */

router.put(
  "/change-password-first",
  requireAuth,
  authController.changePasswordFirst
);

router.post("/forgot-password", authController.forgotPassword);
router.post("/reset-password", authController.resetPassword);

router.post(
  "/upload-avatar",
  requireAuth,
  uploadProfile.single("avatar"),
  authController.uploadAvatar
);


/* ===============================
   TEST ROUTE
=============================== */

router.get("/test", (req, res) => {
  res.json({ ok: true });
});


module.exports = router;