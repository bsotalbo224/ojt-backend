const express = require("express");
const router = express.Router();
const multer = require("multer");
const { CloudinaryStorage } = require("multer-storage-cloudinary");
const cloudinary = require("../config/cloudinary");

const storage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: "ojt-system/editor-images",
    resource_type: "image",
  },
});

const upload = multer({ storage });

router.post("/image", upload.single("image"), (req, res) => {
  try {
    return res.json({
      url: req.file.path, // Cloudinary URL
    });
  } catch (err) {
    console.error("UPLOAD IMAGE ERROR:", err);
    res.status(500).json({ message: "Upload failed" });
  }
});

module.exports = router;