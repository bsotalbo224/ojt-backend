const AcademicYearModel = require("../models/AcademicYearModel");

exports.getAll = async (req, res) => {
  try {

    const years = await AcademicYearModel.getAll();

    res.json({
      success: true,
      academicYears: years
    });

  } catch (err) {

    console.error(err);

    res.status(500).json({
      success: false,
      error: err.message
    });

  }
};

exports.getActive = async (req, res) => {
  try {

    const year = await AcademicYearModel.getActive();

    res.json({
      success: true,
      academicYear: year
    });

  } catch (err) {

    console.error(err);

    res.status(500).json({
      success: false,
      error: err.message
    });

  }
};

exports.create = async (req, res) => {
  try {

    const id = await AcademicYearModel.create(req.body);

    res.status(201).json({
      success: true,
      academic_year_id: id
    });

  } catch (err) {

    console.error(err);

    res.status(500).json({
      error: err.message
    });

  }
};

exports.setActive = async (req, res) => {
  try {


    await AcademicYearModel.setActive(
      req.params.id
    );

    res.json({
      success: true
    });

  } catch (err) {

    console.error(err);

    res.status(500).json({
      error: err.message
    });

  }
};