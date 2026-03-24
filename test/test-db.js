const db = require('../db');

async function testDB() {
  try {
    const [rows] = await db.query('SELECT 1 + 1 AS result');
    console.log(rows); // should print: [{ result: 2 }]
  } catch (err) {
    console.error(err);
  }
}

testDB();
