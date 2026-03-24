const db = require("../config/db");

/* =====================================================
GET LOCATIONS BY COMPANY
===================================================== */
async function getLocationsByCompany(company_id) {
  const [rows] = await db.query(
    `SELECT 
        location_id,
        company_id,
        location_name,
        latitude,
        longitude,
        radius_meters
     FROM ojt_locations
     WHERE company_id = ?
     ORDER BY location_name ASC`,
    [company_id]
  );

  return rows;
}

/* =====================================================
GET SINGLE LOCATION
===================================================== */
async function getLocationById(location_id) {
  const [[row]] = await db.query(
    `SELECT 
        location_id,
        company_id,
        location_name,
        latitude,
        longitude,
        radius_meters
     FROM ojt_locations
     WHERE location_id = ?`,
    [location_id]
  );

  return row;
}

/* =====================================================
CREATE LOCATION
===================================================== */
async function createLocation(data) {
  const {
    company_id,
    location_name,
    latitude,
    longitude,
    radius_meters
  } = data;

  const [result] = await db.query(
    `INSERT INTO ojt_locations
     (company_id, location_name, latitude, longitude, radius_meters)
     VALUES (?, ?, ?, ?, ?)`,
    [
      company_id,
      (location_name || "").substring(0, 150),
      latitude,
      longitude,
      radius_meters || 100
    ]
  );

  return {
    location_id: result.insertId,
    company_id,
    location_name,
    latitude,
    longitude,
    radius_meters: radius_meters || 100
  };
}

/* =====================================================
UPDATE LOCATION
===================================================== */
async function updateLocation(location_id, data) {
  const {
    location_name,
    latitude,
    longitude,
    radius_meters
  } = data;

  await db.query(
    `UPDATE ojt_locations
     SET location_name=?, latitude=?, longitude=?, radius_meters=?
     WHERE location_id=?`,
    [
      (location_name || "").substring(0, 150),
      latitude,
      longitude,
      radius_meters,
      location_id
    ]
  );

  return { success: true };
}

/* =====================================================
DELETE LOCATION
===================================================== */
async function deleteLocation(location_id) {
  await db.query(
    `DELETE FROM ojt_locations WHERE location_id=?`,
    [location_id]
  );

  return { success: true };
}

module.exports = {
  getLocationsByCompany,
  getLocationById,
  createLocation,
  updateLocation,
  deleteLocation
};
