
const { runApp } = require("../lib/runner");

module.exports = async (req, res) => {
  try {
    const method = req.method || "GET";
    let args = [];
    if (method === 'POST' || method === 'GET') { const q = req.query || {}; const b = req.body || {}; const n = (q['n'] || b['n'] || '').toString().trim(); if (n) args.push(n); }

    const result = await runApp("create", args);
    const ok = result.code === 0 || result.code === null;
    res.status(ok ? 200 : 500).json({
      success: ok,
      command: "create", args,
      stdout: result.out,
      stderr: result.err
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
};
