const db = require("../config/db");

/* =====================================================
GET ALL COMPANIES
===================================================== */
async function getAllCompanies() {
  const [rows] = await db.query(`
  SELECT 
  c.company_id,
  c.company_name,
  c.address,
  c.is_active,
  l.latitude,
  l.longitude,
  l.radius_meters,
  COUNT(DISTINCT l.location_id) AS total_locations,
  COUNT(DISTINCT s.student_id) AS total_students
FROM companies c
LEFT JOIN ojt_locations l 
  ON l.company_id = c.company_id
  AND l.location_id = (
    SELECT location_id
    FROM ojt_locations
    WHERE company_id = c.company_id
    LIMIT 1
  )
LEFT JOIN students s ON s.company_id = c.company_id
GROUP BY 
  c.company_id,
  c.company_name,
  c.address,
  c.is_active,
  l.latitude,
  l.longitude,
  l.radius_meters
ORDER BY c.company_name ASC
`);

  return rows;
}

/* =====================================================
COMPANIES SUMMARY
===================================================== */
async function getCompaniesSummary() {
  const [rows] = await db.query(`
    SELECT 
      c.company_id,
      c.company_name,
      c.address,
      COUNT(s.student_id) AS totalInterns
    FROM companies c
    LEFT JOIN students s 
      ON s.company_id = c.company_id
    GROUP BY 
      c.company_id,
      c.company_name,
      c.address
    ORDER BY c.company_name ASC
  `);

  return rows;
}

/* =====================================================
CREATE COMPANY + OPTIONAL LOCATION
===================================================== */
async function createCompany(data) {
  const conn = await db.getConnection();

  try {
    const {
      company_name,
      address,
      latitude,
      longitude,
      location_name,
      radius_meters
    } = data;

    await conn.beginTransaction();

    const [result] = await conn.query(
      `INSERT INTO companies 
       (company_name, address)
       VALUES (?, ?)`,
      [company_name, address]
    );

    const company_id = result.insertId;

    if (latitude && longitude) {
      await conn.query(
        `INSERT INTO ojt_locations
         (company_id, location_name, latitude, longitude, radius_meters)
         VALUES (?, ?, ?, ?, ?)`,
        [
          company_id,
          (location_name || company_name).substring(0, 150),
          latitude,
          longitude,
          radius_meters ?? 100
        ]
      );
    }

    await conn.commit();

    return {
      company_id,
      company_name,
      address,
      is_active: 1
    };

  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/* =====================================================
UPDATE COMPANY
===================================================== */
async function updateCompany(id, data) {

  const conn = await db.getConnection();

  try {
    const {
      company_name,
      address,
      latitude,
      longitude,
      location_name,
      radius_meters
    } = data;

    await conn.beginTransaction();

    /* Update company info */
    await conn.query(
      `UPDATE companies 
       SET company_name=?, address=?
       WHERE company_id=?`,
      [company_name, address, id]
    );

    /* If location provided */
    if (latitude && longitude) {

      const [[existingLocation]] = await conn.query(
        `SELECT location_id FROM ojt_locations WHERE company_id=?`,
        [id]
      );

      if (existingLocation) {

        /* Update existing location */
        await conn.query(
          `UPDATE ojt_locations
   SET location_name=?, latitude=?, longitude=?, radius_meters=?
   WHERE location_id=?`,
          [
            (location_name || company_name).substring(0, 150),
            latitude,
            longitude,
            radius_meters ?? 100,
            existingLocation.location_id
          ]
        );

      } else {

        /* Insert new location */
        await conn.query(
          `INSERT INTO ojt_locations
           (company_id, location_name, latitude, longitude, radius_meters)
           VALUES (?, ?, ?, ?, ?)`,
          [
            id,
            (location_name || company_name).substring(0, 150),
            latitude,
            longitude,
            radius_meters ?? 100
          ]
        );
      }
    }

    await conn.commit();

    return { success: true };

  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/* =====================================================
TOGGLE STATUS
===================================================== */
async function toggleCompanyStatus(id, is_active) {
  await db.query(
    `UPDATE companies SET is_active=? WHERE company_id=?`,
    [is_active, id]
  );

  return { success: true };
}

/* =====================================================
DELETE COMPANY
===================================================== */
async function deleteCompany(id) {

  await db.query(`DELETE FROM ojt_locations WHERE company_id=?`, [id]);
  await db.query(`DELETE FROM companies WHERE company_id=?`, [id]);

  return { success: true };
}

module.exports = {
  getAllCompanies,
  getCompaniesSummary,
  createCompany,
  updateCompany,
  toggleCompanyStatus,
  deleteCompany
};