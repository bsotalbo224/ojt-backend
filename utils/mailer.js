const nodemailer = require("nodemailer");

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

/* ==============================
   STUDENT EMAIL
============================== */
async function sendStudentCredentials(email, password, name) {
  try {
    await transporter.sendMail({
      from: `"OJT System" <${process.env.EMAIL_USER}>`,
      to: email,
      subject: "Your OJT Student Account",
      html: `
        <h2>Welcome to OJT Monitoring System</h2>
        <p>Hello ${name},</p>
        <p>Your <b>student account</b> has been created by the administrator.</p>

        <p><b>Login Email:</b> ${email}</p>
        <p><b>Password:</b> ${password}</p>

        <p>Please log in and change your password immediately.</p>

        <hr>
        <small>This is an automated message.</small>
      `,
    });
  } catch (error) {
    console.error("EMAIL ERROR (Student):", error);
  }
}

/* ==============================
   COORDINATOR EMAIL
============================== */
async function sendCoordinatorCredentials(email, password, name, department) {
  await transporter.sendMail({
    from: `"OJT System" <${process.env.EMAIL_USER}>`,
    to: email,
    subject: "Your OJT Coordinator Account",
    html: `
      <h2>Welcome to OJT Monitoring System</h2>
      <p>Hello ${name},</p>
      <p>Your <b>coordinator account</b> has been created by the administrator.</p>

      <p><b>Department:</b> ${department}</p>
      <p><b>Login Email:</b> ${email}</p>
      <p><b>Password:</b> ${password}</p>

      <p>You can now manage assigned OJT students.</p>
      <p>Please log in and change your password immediately.</p>

      <hr>
      <small>This is an automated message.</small>
    `,
  });
}

module.exports = {
  sendStudentCredentials,
  sendCoordinatorCredentials,
};
