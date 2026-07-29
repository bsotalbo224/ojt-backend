/**
 * One-time maintenance script — rebuilds every department consultation
 * group so conversation_members matches active students + active
 * coordinators, for every department/academic-year pair that currently
 * has students.
 *
 * Run once after deploying Automatic Department Group Management:
 *   node scripts/syncDepartmentGroups.js
 *
 * All synchronization logic is reused from MessageModel — this script
 * only discovers which department/year pairs need syncing, calls the
 * existing method, and reports the results. It does not create
 * conversations or insert/remove members itself.
 */
require("dotenv").config();

const db = require("../config/db");
const MessageModel = require("../models/messageModel");

const run = async () => {
  const conn = await db.getConnection();

  const stats = {
    departmentsProcessed: 0,
    academicYearsProcessed: 0,
    groupsSynchronized: 0,
    groupsCreated: 0,
    membersAdded: 0,
    membersRemoved: 0
  };

  const summaryLines = [];

  try {
    await conn.beginTransaction();

    const [departments] = await conn.query(`
      SELECT department_id, department_name
      FROM departments
      ORDER BY department_name
    `);

    // Looked up once and reused for every department/year pair below,
    // instead of re-querying academic_years inside the loop.
    const [academicYears] = await conn.query(`
      SELECT academic_year_id, academic_year_name
      FROM academic_years
    `);

    const academicYearNamesById = new Map(
      academicYears.map((year) => [year.academic_year_id, year.academic_year_name])
    );

    for (const department of departments) {
      stats.departmentsProcessed += 1;

      const [yearRows] = await conn.query(
        `SELECT DISTINCT academic_year_id
         FROM students
         WHERE department_id = ?
         AND academic_year_id IS NOT NULL`,
        [department.department_id]
      );

      for (const { academic_year_id: academicYearId } of yearRows) {
        stats.academicYearsProcessed += 1;

        // Reuses the existing helper (not sync logic) purely to know
        // whether this group already existed, for the summary below.
        const existingConversation = await MessageModel.getDepartmentConversation(
          conn,
          department.department_id,
          academicYearId
        );

        const result = await MessageModel.syncDepartmentConversation(
          conn,
          department.department_id,
          academicYearId,
          null
        );

        stats.groupsSynchronized += 1;
        stats.membersAdded += result.addedCount;
        stats.membersRemoved += result.removedCount;

        if (!existingConversation) {
          stats.groupsCreated += 1;
        }

        const yearLabel = academicYearNamesById.get(academicYearId) ?? academicYearId;
        summaryLines.push(`✓ ${department.department_name} (${yearLabel})`);
      }
    }

    await conn.commit();

    console.log("=========================================");
    console.log("Department Group Synchronization");
    console.log("=========================================");
    summaryLines.forEach((line) => console.log(line));
    console.log("-----------------------------------------");
    console.log(`Departments Processed : ${stats.departmentsProcessed}`);
    console.log(`Academic Years        : ${stats.academicYearsProcessed}`);
    console.log(`Groups Synchronized   : ${stats.groupsSynchronized}`);
    console.log(`Groups Created        : ${stats.groupsCreated}`);
    console.log(`Members Added         : ${stats.membersAdded}`);
    console.log(`Members Removed       : ${stats.membersRemoved}`);
    console.log("Synchronization Complete.");
    console.log("=========================================");

    process.exit(0);

  } catch (err) {
    await conn.rollback();
    console.error("Department group synchronization failed:", err);
    process.exit(1);

  } finally {
    conn.release();
  }
};

run();