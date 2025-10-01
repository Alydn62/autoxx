
const { runApp } = require("../lib/runner");

module.exports = async (req, res) => {
  try {
    const method = req.method || "GET";
    let args = [];


    const result = await runApp("check-retry", args);
    const ok = result.code === 0 || result.code === null;
    res.status(ok ? 200 : 500).json({
      success: ok,
      command: "check-retry",
      stdout: result.out,
      stderr: result.err
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
};
