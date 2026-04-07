const mysql = require('mysql2/promise');

const pool = mysql.createPool(process.env.DB_URL);

(async () => {
  try {
    const conn = await pool.getConnection();
    await conn.query("SET time_zone = '+08:00'");
    conn.release();
    console.log(" MySQL timezone set to +08:00");
  } catch (err) {
    console.error(" Failed to set timezone:", err);
  }
})();

module.exports = pool;