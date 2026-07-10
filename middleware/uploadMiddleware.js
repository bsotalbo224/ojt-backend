const multer = require("multer");
const path = require("path");
const { CloudinaryStorage } = require("multer-storage-cloudinary");
const cloudinary = require("../config/cloudinary");

// Helpers
const sanitize = (originalName) => {
  const ext = path.extname(originalName).slice(0, 10);
  const base = path.basename(originalName, path.extname(originalName));

  let clean = base
    .replace(/\s+/g, "-")
    .replace(/[^\w.-]/g, "")
    .replace(/^[-.]+/, "")
    .slice(0, 100);

  if (!clean) {
    clean = "file";
  }

  return `${clean}${ext}`;
};

const resolveFolder = (originalUrl) => {
  if (originalUrl.includes("narratives")) return "ojt-system/narratives";
  if (originalUrl.includes("logs")) return "ojt-system/daily_logs";
  if (originalUrl.includes("departments")) return "ojt-system/departments";
  if (originalUrl.includes("attendance")) return "ojt-system/early-attendance";
  if (originalUrl.includes("messages")) return "ojt-system/messages";
  return "ojt-system/misc";
};

const ALLOWED_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/zip",
  "application/x-zip-compressed",
  "text/plain"
];

// Storage
const storage = new CloudinaryStorage({
  cloudinary,
  params: async (req, file) => ({
    folder: resolveFolder(req.originalUrl),
    resource_type: "auto",
    public_id: `${Date.now()}-${sanitize(file.originalname)}`
  })
});

// Filter
const fileFilter = (req, file, cb) => {
  if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
    return cb(new Error("Unsupported file type"));
  }

  cb(null, true);
};

module.exports = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024
  }
});