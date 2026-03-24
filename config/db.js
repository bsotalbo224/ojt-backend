const mysql = require('mysql2');

const pool = mysql.createPool(process.env.MYSQL_URL);

module.exports = pool.promise();