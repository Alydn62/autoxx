
const { spawn } = require("child_process");
const path = require("path");

function runApp(cmd, args = []) {
  return new Promise((resolve) => {
    const entry = path.join(process.cwd(), "app.js");
    const proc = spawn("node", [entry, cmd, ...args], {
      env: process.env,
      cwd: process.cwd()
    });

    let out = "";
    let err = "";

    proc.stdout.on("data", (d) => (out += d.toString()));
    proc.stderr.on("data", (d) => (err += d.toString()));

    proc.on("close", (code) => {
      resolve({ code, out, err });
    });
  });
}

module.exports = { runApp };
