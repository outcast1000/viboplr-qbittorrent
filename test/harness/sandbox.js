const fs = require("node:fs");
const path = require("node:path");

const INDEX_PATH = path.join(__dirname, "..", "..", "index.js");

// Globals the host's frozen sandbox does NOT provide. Shadowing them as throwing
// bindings means any accidental use inside index.js fails loudly in tests rather
// than working here and breaking in the app.
// NOTE: Math, JSON, Date, Promise, timers, parseInt, etc. ARE provided by the
// host and must NOT be shadowed here.
const FORBIDDEN = ["fetch", "require", "process", "module", "exports", "__dirname", "__filename", "global"];

function loadPlugin() {
  const code = fs.readFileSync(INDEX_PATH, "utf8");

  const preamble = FORBIDDEN.map(
    (n) =>
      `var ${n} = new Proxy(function(){}, { get: function(){ throw new Error("forbidden global accessed in sandbox: ${n}"); }, apply: function(){ throw new Error("forbidden global called in sandbox: ${n}"); } });`,
  ).join("\n");

  const factory = new Function("api", "window", "globalThis", "self", "document", preamble + "\n" + code);

  const sandboxGlobal = Object.freeze({});
  return factory(undefined, sandboxGlobal, sandboxGlobal, sandboxGlobal, sandboxGlobal);
}

module.exports = { loadPlugin };
