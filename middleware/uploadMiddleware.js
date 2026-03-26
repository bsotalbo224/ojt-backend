const multer = require("multer");
const { CloudinaryStorage } = require("multer-storage-cloudinary");
const cloudinary = require("../config/cloudinary");

// sanitize filename for safe Cloudinary public_id
const sanitize = (name) =>
  name.replace(/\s+/g, "-").replace(/[^\w.-]/g, "");

const storage = new CloudinaryStorage({
  cloudinary,
  params: async (req, file) => {
    let folder = "ojt-system/misc";

    if (req.originalUrl.includes("narratives")) {
      folder = "ojt-system/narratives";
    } else if (req.originalUrl.includes("logs")) {
      folder = "ojt-system/daily_logs";
    } else if (req.originalUrl.includes("departments")) {
      folder = "ojt-system/departments";
    }

    return {
      folder,
      resource_type: "auto", // supports images, pdf, docs
      public_id: `${Date.now()}-${sanitize(file.originalname)}`,
    };
  },
});

// production-safe file types
const fileFilter = (req, file, cb) => {
  const allowed = [
    "image/png",
    "image/jpeg",
    "image/webp",
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  ];

  if (!allowed.includes(file.mimetype)) {
    return cb(null, false);
  }

  cb(null, true);
};

module.exports = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB
  },
});