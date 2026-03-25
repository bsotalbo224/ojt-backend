require("dotenv").config();

const fs = require("fs");
const path = require("path");
const db = require("./config/db");
const cloudinary = require("./config/cloudinary");

// 🔐 SAFETY SWITCH
const DRY_RUN = false; // ✅ CHANGE TO false WHEN READY

// uploads root
const UPLOAD_DIR = path.join(__dirname, "uploads");

// detect folder
function getFolder(filePath) {
  if (filePath.includes("narratives")) return "ojt-system/narratives";
  if (filePath.includes("daily_logs")) return "ojt-system/daily_logs";
  if (filePath.includes("profiles")) return "ojt-system/profiles";
  if (filePath.includes("departments")) return "ojt-system/departments";
  return "ojt-system/misc";
}

// 🔄 MIGRATE ATTACHMENTS
async function migrateAttachments() {
  console.log("\n📦 Migrating ATTACHMENTS...");

 const [rows] = await db.query(`
  SELECT attachment_id, file_path
  FROM attachments
  WHERE file_path IS NOT NULL
`);

  console.log(`Found ${rows.length} attachment(s)`);

  for (const file of rows) {
    let cleanPath = file.file_path;

// handle paths without "uploads/"
if (!cleanPath.startsWith("uploads")) {
  cleanPath = "uploads/" + cleanPath;
}

const localPath = path.join(__dirname, cleanPath);

    if (!fs.existsSync(localPath)) {
      console.log(`⚠️ Missing file: ${file.file_path}`);
      continue;
    }

    try {
      const folder = getFolder(file.file_path);

      const result = await cloudinary.uploader.upload(localPath, {
        folder,
        resource_type: "auto",
      });

      console.log(`✅ Uploaded: ${file.file_path}`);

      if (!DRY_RUN) {
        await db.query(
          "UPDATE attachments SET file_path = ? WHERE attachment_id = ?",
          [result.secure_url, file.attachment_id]
        );
      }

    } catch (err) {
      console.error(`❌ Failed: ${file.file_path}`, err.message);
    }
  }
}

// 👤 MIGRATE PROFILE IMAGES
async function migrateProfiles() {
  console.log("\n👤 Migrating PROFILE IMAGES...");

  const [rows] = await db.query(`
    SELECT user_id, photo
    FROM users
    WHERE photo LIKE '/uploads%'
  `);

  console.log(`Found ${rows.length} profile(s)`);

  for (const user of rows) {
    const localPath = path.join(__dirname, user.photo);

    if (!fs.existsSync(localPath)) {
      console.log(`⚠️ Missing profile: ${user.photo}`);
      continue;
    }

    try {
      const result = await cloudinary.uploader.upload(localPath, {
        folder: "ojt-system/profiles",
        resource_type: "image",
      });

      console.log(`✅ Uploaded profile: ${user.user_id}`);

      if (!DRY_RUN) {
        await db.query(
          "UPDATE users SET photo = ? WHERE user_id = ?",
          [result.secure_url, user.user_id]
        );
      }

    } catch (err) {
      console.error(`❌ Failed profile: ${user.user_id}`, err.message);
    }
  }
}

// 🏫 MIGRATE DEPARTMENT LOGOS
async function migrateDepartments() {
  console.log("\n🏫 Migrating DEPARTMENT LOGOS...");

  const [rows] = await db.query(`
    SELECT department_id, logo
    FROM departments
    WHERE logo LIKE '/uploads%'
  `);

  console.log(`Found ${rows.length} department logo(s)`);

  for (const dept of rows) {
    const localPath = path.join(__dirname, dept.logo);

    if (!fs.existsSync(localPath)) {
      console.log(`⚠️ Missing logo: ${dept.logo}`);
      continue;
    }

    try {
      const result = await cloudinary.uploader.upload(localPath, {
        folder: "ojt-system/departments",
        resource_type: "image",
      });

      console.log(`✅ Uploaded department: ${dept.department_id}`);

      if (!DRY_RUN) {
        await db.query(
          "UPDATE departments SET logo = ? WHERE department_id = ?",
          [result.secure_url, dept.department_id]
        );
      }

    } catch (err) {
      console.error(`❌ Failed department: ${dept.department_id}`, err.message);
    }
  }
}

// 🚀 MAIN
async function runMigration() {
  console.log("🚀 STARTING CLOUDINARY MIGRATION");
  console.log("DRY RUN:", DRY_RUN ? "ON (no DB changes)" : "OFF (will update DB)");

  try {
    await migrateAttachments();
    await migrateProfiles();
    await migrateDepartments();

    console.log("\n🎉 MIGRATION COMPLETE");
    if (DRY_RUN) {
      console.log("⚠️ No DB changes made (DRY RUN)");
    } else {
      console.log("✅ Database updated with Cloudinary URLs");
    }

  } catch (err) {
    console.error("🔥 Migration failed:", err);
  }
}

runMigration();