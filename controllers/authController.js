const db = require("../config/db");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const nodemailer = require("nodemailer");

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

/*
=================================
 REGISTER
=================================
*/
exports.register = async (req, res) => {
  const { email, password, role, f_name, l_name } = req.body;

  try {
    if (!email || !password || !role) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields",
      });
    }

    const [existing] = await db.query(
      "SELECT user_id FROM users WHERE email = ?",
      [email]
    );

    if (existing.length) {
      return res.status(409).json({
        success: false,
        message: "Email already registered"
      });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const [result] = await db.query(
      `INSERT INTO users (email, password, role, f_name, l_name)
       VALUES (?, ?, ?, ?, ?)`,
      [email, hashedPassword, role, f_name || null, l_name || null]
    );

    const userId = result.insertId;

    if (role === "student") {
      await db.query("INSERT INTO students (user_id) VALUES (?)", [userId]);
    }

    if (role === "coordinator") {
      await db.query("INSERT INTO coordinators (user_id) VALUES (?)", [userId]);
    }

    if (role === "admin") {
      await db.query("INSERT INTO admins (user_id) VALUES (?)", [userId]);
    }

    return res.status(201).json({
      success: true,
      message: "User registered successfully",
    });

  } catch (err) {
    console.error("REGISTER ERROR:", err);
    return res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
};


/*
=================================
 LOGIN
=================================
*/
exports.login = async (req, res) => {
  const { email, password } = req.body;

  try {
    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: "Email and password are required",
      });
    }

    const [users] = await db.query(
      `SELECT 
        user_id,
        email,
        password,
        role,
        f_name,
        l_name,
        photo,
        must_change_password
       FROM users
       WHERE email = ?`,
      [email]
    );

    if (!users.length) {
      return res.status(401).json({
        success: false,
        message: "Invalid credentials",
      });
    }

    const user = users[0];

    const isMatch = await bcrypt.compare(password, user.password);

    if (!isMatch) {
      return res.status(401).json({
        success: false,
        message: "Invalid credentials",
      });
    }

    const roles = [];

    let student_id = null;
    let coordinator_id = null;

    let student_department_id = null;
    let coordinator_department_id = null;

    let student_department_name = null;
    let coordinator_department_name = null;

    let student_departmentTheme = "green";
    let coordinator_departmentTheme = "green";

    let student_departmentLogo = null;
    let coordinator_departmentLogo = null;

    /*
    =========================
    STUDENT CHECK
    =========================
    */
    const [s] = await db.query(
      `SELECT student_id, department_id, is_active
       FROM students
       WHERE user_id = ?`,
      [user.user_id]
    );

    if (s.length) {
      roles.push("student");
      student_id = s[0].student_id;
      student_department_id = s[0].department_id;

      if (!s[0].is_active) {
        return res.status(403).json({
          success: false,
          message: "Your account has been deactivated."
        });
      }
    }

    /*
    =========================
    COORDINATOR CHECK
    =========================
    */
    const [c] = await db.query(
      `SELECT coordinator_id, department_id, is_active
       FROM coordinators
       WHERE user_id = ?`,
      [user.user_id]
    );

    if (c.length) {
      roles.push("coordinator");
      coordinator_id = c[0].coordinator_id;
      coordinator_department_id = c[0].department_id;

      if (!c[0].is_active) {
        return res.status(403).json({
          success: false,
          message: "Your account has been deactivated."
        });
      }
    }

    /*
    =========================
    ADMIN CHECK
    =========================
    */
    const [a] = await db.query(
      `SELECT admin_id
       FROM admins
       WHERE user_id = ?`,
      [user.user_id]
    );

    if (a.length) {
      roles.push("admin");
    }

    /*
    =========================
    GET DEPARTMENTS
    =========================
    */

    if (student_department_id) {
      const [dept] = await db.query(
        `SELECT department_name, theme, logo 
         FROM departments 
         WHERE department_id = ?`,
        [student_department_id]
      );

      if (dept.length) {
        student_department_name = dept[0].department_name;
        student_departmentTheme = dept[0].theme || "green";
        student_departmentLogo = dept[0].logo || null;
      }
    }

    if (coordinator_department_id) {
      const [dept] = await db.query(
        `SELECT department_name, theme, logo 
         FROM departments 
         WHERE department_id = ?`,
        [coordinator_department_id]
      );

      if (dept.length) {
        coordinator_department_name = dept[0].department_name;
        coordinator_departmentTheme = dept[0].theme || "green";
        coordinator_departmentLogo = dept[0].logo || null;
      }
    }

    /*
    =========================
    JWT TOKEN
    =========================
    */
    if (!process.env.JWT_SECRET) {
      throw new Error("JWT_SECRET is not defined");
    }

    const token = jwt.sign(
      {
        user_id: user.user_id,
        roles,
        student_id,
        coordinator_id
      },
      process.env.JWT_SECRET,
      { expiresIn: "8h" }
    );

    const primaryRole =
      roles.includes("admin")
        ? "admin"
        : roles.includes("coordinator")
          ? "coordinator"
          : "student";

    let department = null;

    // Priority: coordinator > student
    if (coordinator_department_id) {
      department = {
        id: coordinator_department_id,
        name: coordinator_department_name,
        logo: coordinator_departmentLogo,
        theme: coordinator_departmentTheme,
      };
    } else if (student_department_id) {
      department = {
        id: student_department_id,
        name: student_department_name,
        logo: student_departmentLogo,
        theme: student_departmentTheme,
      };
    }

    return res.status(200).json({
      success: true,
      token,
      user: {
        user_id: user.user_id,
        email: user.email,

        name: `${user.f_name || ""} ${user.l_name || ""}`.trim(),

        f_name: user.f_name,
        l_name: user.l_name,
        photo: user.photo,

        role: primaryRole,
        roles,

        student_id,
        coordinator_id,

        // ✅ CLEAN STRUCTURE (MATCHES /auth/me)
        department,

        must_change_password: user.must_change_password
      },
    });

  } catch (err) {
    console.error("LOGIN ERROR:", err);
    return res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
};

exports.getMe = async (req, res) => {
  try {
    const user_id = req.user.user_id;

    const [users] = await db.query(
      `SELECT user_id, email, f_name, l_name, photo, must_change_password
       FROM users
       WHERE user_id = ?`,
      [user_id]
    );

    if (!users.length) {
      return res.status(404).json({ success: false });
    }

    const user = users[0];

    let roles = [];
    let student_id = null;
    let coordinator_id = null;
    let department_id = null;

    /* STUDENT */
    const [s] = await db.query(
      `SELECT student_id, department_id FROM students WHERE user_id = ?`,
      [user_id]
    );

    if (s.length) {
      roles.push("student");
      student_id = s[0].student_id;
      department_id = s[0].department_id;
    }

    /* COORDINATOR */
    const [c] = await db.query(
      `SELECT coordinator_id, department_id FROM coordinators WHERE user_id = ?`,
      [user_id]
    );

    if (c.length) {
      roles.push("coordinator");
      coordinator_id = c[0].coordinator_id;

      // ✅ Coordinator overrides department (important)
      department_id = c[0].department_id;
    }

    /* ADMIN */
    const [a] = await db.query(
      `SELECT admin_id FROM admins WHERE user_id = ?`,
      [user_id]
    );

    if (a.length) {
      roles.push("admin");
    }

    /* GET DEPARTMENT (ONLY ONE!) */
    let department = null;

    if (department_id) {
      const [dept] = await db.query(
        `SELECT department_id, department_name, theme, logo
         FROM departments
         WHERE department_id = ?`,
        [department_id]
      );

      if (dept.length) {
        department = {
          id: dept[0].department_id,
          name: dept[0].department_name,
          theme: dept[0].theme || "green",
          logo: dept[0].logo || null,
        };
      }
    }

    const primaryRole =
      roles.includes("admin")
        ? "admin"
        : roles.includes("coordinator")
          ? "coordinator"
          : "student";

    res.json({
      success: true,
      user: {
        user_id: user.user_id,
        email: user.email,

        // ✅ ALWAYS SAFE NAME
        name: `${user.f_name || ""} ${user.l_name || ""}`.trim(),

        f_name: user.f_name,
        l_name: user.l_name,
        photo: user.photo,

        role: primaryRole,
        roles,

        student_id,
        coordinator_id,

        // ✅ CLEAN STRUCTURE
        department,

        must_change_password: user.must_change_password,
      }
    });

  } catch (err) {
    console.error("GET ME ERROR:", err);
    res.status(500).json({ success: false });
  }
};


/*
=================================
 FIRST LOGIN PASSWORD CHANGE
=================================
*/
exports.changePasswordFirst = async (req, res) => {
  const { new_password } = req.body;

  if (!new_password) {
    return res.status(400).json({
      success: false,
      message: "New password is required"
    });
  }

  try {
    const hashed = await bcrypt.hash(new_password, 10);

    await db.query(
      `UPDATE users
       SET password = ?, must_change_password = FALSE
       WHERE user_id = ?`,
      [hashed, req.user.user_id]
    );

    res.json({
      success: true,
      message: "Password updated successfully"
    });

  } catch (err) {
    console.error("CHANGE PASSWORD FIRST ERROR:", err);
    res.status(500).json({
      success: false,
      message: "Server error"
    });
  }
};

/*
=================================
 FORGOT PASSWORD
=================================
*/
exports.forgotPassword = async (req, res) => {
  const { email } = req.body;

  // Validation
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  if (!email || !emailRegex.test(email)) {
    return res.status(400).json({
      success: false,
      message: "Valid email is required",
    });
  }

  try {
    const [users] = await db.query(
      "SELECT user_id, email FROM users WHERE email = ?",
      [email]
    );

    // Do NOT reveal if email exists (security best practice)
    if (!users.length) {
      return res.status(200).json({
        success: true,
        message: "If the email exists, a reset link has been sent",
      });
    }

    const user = users[0];

    // Generate secure token
    const token = crypto.randomBytes(32).toString("hex");

    // Expiry: 1 hour
    const expiry = new Date(Date.now() + 60 * 60 * 1000);

    await db.query(
      `UPDATE users 
       SET reset_token = ?, reset_token_expiry = ?
       WHERE user_id = ?`,
      [token, expiry, user.user_id]
    );

    // Reset link (adjust if needed)
    const resetLink = `${process.env.FRONTEND_URL}/reset-password/${token}`;

    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
      throw new Error("Email configuration is missing in .env");
    }

    await transporter.sendMail({
      to: email,
      subject: "OJT System - Password Reset",
      html: `
        <h3>Password Reset Request</h3>
        <p>You requested to reset your password.</p>
        <p>Click the link below to continue:</p>
        <a href="${resetLink}">${resetLink}</a>
        <p>This link will expire in 1 hour.</p>
      `,
    });

    return res.json({
      success: true,
      message: "If the email exists, a reset link has been sent",
    });

  } catch (err) {
    console.error("FORGOT PASSWORD ERROR:", err);
    return res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
};

/*
=================================
 RESET PASSWORD
=================================
*/
exports.resetPassword = async (req, res) => {
  const { token, password } = req.body;

  // Validation
  if (!token || !password) {
    return res.status(400).json({
      success: false,
      message: "Token and new password are required",
    });
  }

  // Password strength check
  const strongPassword = /^(?=.*[A-Za-z])(?=.*\d).{6,}$/;

  if (!strongPassword.test(password)) {
    return res.status(400).json({
      success: false,
      message: "Password must contain at least 6 characters, including letters, numbers and symbols",
    });
  }

  try {
    const [users] = await db.query(
      `SELECT user_id 
       FROM users 
       WHERE reset_token = ? 
       AND reset_token_expiry > NOW()`,
      [token]
    );

    if (!users.length) {
      return res.status(400).json({
        success: false,
        message: "Invalid or expired token",
      });
    }

    const user = users[0];

    const hashedPassword = await bcrypt.hash(password, 10);

    await db.query(
      `UPDATE users 
       SET password = ?, 
           reset_token = NULL, 
           reset_token_expiry = NULL,
           must_change_password = FALSE
       WHERE user_id = ?`,
      [hashedPassword, user.user_id]
    );

    return res.json({
      success: true,
      message: "Password has been reset successfully",
    });

  } catch (err) {
    console.error("RESET PASSWORD ERROR:", err);
    return res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
};


/*
=================================
 UPLOAD AVATAR
=================================
*/
exports.uploadAvatar = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "No file uploaded"
      });
    }

    const userId = req.user.user_id;

    // OPTIONAL BUT IMPORTANT: delete old avatar
    const [[existing]] = await db.query(
      "SELECT photo FROM users WHERE user_id = ?",
      [userId]
    );

    if (existing?.photo) {
      try {
        // Extract public_id from URL
        const urlParts = existing.photo.split("/");
        const fileName = urlParts[urlParts.length - 1];
        const publicId = `ojt-system/profiles/${fileName.split(".")[0]}`;

        await cloudinary.uploader.destroy(publicId);
      } catch (err) {
        console.warn("Cloudinary delete skipped:", err.message);
      }
    }

    // Save Cloudinary URL
    const photoUrl = req.file.path;

    await db.query(
      "UPDATE users SET photo = ? WHERE user_id = ?",
      [photoUrl, userId]
    );

    const [rows] = await db.query(
      `SELECT user_id, f_name, l_name, email, photo
       FROM users
       WHERE user_id = ?`,
      [userId]
    );

    const u = rows[0];

    res.json({
      success: true,
      user: {
        user_id: u.user_id,
        name: `${u.f_name || ""} ${u.l_name || ""}`.trim(),
        email: u.email,
        photo: u.photo, // Cloudinary URL
        role: req.user.roles[0]
      }
    });

  } catch (err) {
    console.error("UPLOAD PROFILE ERROR:", err);
    res.status(500).json({
      success: false,
      message: "Upload failed"
    });
  }
};