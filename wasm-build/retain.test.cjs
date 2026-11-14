// Plain node:assert tests for the retain command in wasm-build/pdftex-worker.js.
// Run with:
//   node wasm-build/retain.test.cjs
//
// The controller is a classic worker script, not a module. The routines under
// test (writeFileRoutine, retainRoutine and the helpers they call) are copied
// out of its source by their declarations and run against an in-memory stand-in
// for Emscripten's FS, so the code that is tested is the code that ships.
"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const WORKROOT = "/work";
const source = fs.readFileSync(path.join(__dirname, "pdftex-worker.js"), "utf8");

// A function's text, from its declaration to the first line that is exactly "}".
function extract(name) {
  const start = source.indexOf("function " + name + "(");
  if (start < 0) throw new Error("no function " + name + " in pdftex-worker.js");
  const end = source.indexOf("\n}\n", start);
  if (end < 0) throw new Error("no closing brace for " + name);
  return source.slice(start, end + 2);
}

// Evaluates the routines against the given FS, worker `self` and reset hook.
function load(FS, self, hcReset) {
  const names = ["retainStamp", "retainDir", "retainRoutine", "writeFileRoutine"];
  const body = names.map((name) => extract(name)).join("\n");
  const factory = new Function(
    "FS", "WORKROOT", "self", "hcReset", "invalidatePreambleForWrite", "hcNoteHostWrite", "console",
    body + "\nreturn { writeFileRoutine, retainRoutine };"
  );
  return factory(FS, WORKROOT, self, hcReset, () => {}, () => {}, console);
}

// In-memory stand-in for the parts of Emscripten's FS the routines use.
// Nodes are kept flat, keyed by absolute path; directories are nodes too.
function fakeFS() {
  const nodes = new Map([["", { dir: true, size: 0, mtime: new Date(0) }]]); // the root
  const enoent = (p) => Object.assign(new Error("ENOENT: " + p), { errno: 44 });
  const parentOf = (p) => p.slice(0, p.lastIndexOf("/"));
  const FS = {
    nodes,
    mkdir(p) {
      if (!nodes.has(parentOf(p))) throw enoent(p);
      nodes.set(p, { dir: true, size: 0, mtime: new Date(0) });
    },
    writeFile(p, content, mtime = new Date()) {
      if (!nodes.has(parentOf(p))) throw enoent(p);
      nodes.set(p, { dir: false, size: content.length, mtime });
    },
    readdir(dir) {
      if (!nodes.has(dir)) throw enoent(dir);
      const out = [".", ".."];
      for (const p of nodes.keys()) {
        if (p.startsWith(dir + "/") && p.indexOf("/", dir.length + 1) < 0) out.push(p.slice(dir.length + 1));
      }
      return out;
    },
    stat(p) {
      const n = nodes.get(p);
      if (!n) throw enoent(p);
      return { mode: n.dir ? 0o40755 : 0o100644, size: n.size, mtime: n.mtime };
    },
    isDir(mode) {
      return (mode & 0o170000) === 0o040000;
    },
    unlink(p) {
      const n = nodes.get(p);
      if (!n || n.dir) throw enoent(p);
      nodes.delete(p);
    },
  };
  FS.mkdir(WORKROOT);
  return FS;
}

function fixture() {
  const FS = fakeFS();
  const posted = [];
  const calls = { hcReset: 0 };
  const self = {
    _retainWrites: Object.create(null),
    _preambleFmtData: "fmt",
    _preambleInputFiles: ["main.tex"],
    _preambleHash: "hash",
    postMessage(msg) {
      posted.push(msg);
    },
  };
  const api = load(FS, self, () => {
    calls.hcReset++;
  });
  return {
    FS,
    self,
    calls,
    api,
    // A write by the host goes through the real writefile routine, so it is recorded.
    host: (rel, content) => api.writeFileRoutine(rel, content),
    // A write by anything else (a compile) leaves no record.
    other: (rel, content, mtime) => FS.writeFile(WORKROOT + "/" + rel, content, mtime),
    has: (rel) => FS.nodes.has(WORKROOT + "/" + rel),
    last: () => posted[posted.length - 1],
  };
}

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

test("files the host did not keep are deleted", () => {
  const t = fixture();
  t.host("main.tex", "\\documentclass{article}");
  t.FS.mkdir(WORKROOT + "/chapters");
  t.host("chapters/one.tex", "one");
  t.other("main.aux", "aux");
  t.api.retainRoutine(["main.tex", "chapters/one.tex"]);
  assert.deepEqual(t.last(), { result: "ok", cmd: "retain", dirty: [] });
  assert.ok(t.has("main.tex"));
  assert.ok(t.has("chapters/one.tex"));
  assert.ok(!t.has("main.aux"), "a file the host did not keep is deleted");
});

test("a kept file the host wrote and nothing changed stays and is not dirty", () => {
  const t = fixture();
  t.host("main.tex", "body");
  t.api.retainRoutine(["main.tex"]);
  assert.deepEqual(t.last().dirty, []);
  assert.ok(t.has("main.tex"));
  assert.ok(t.self._retainWrites["main.tex"], "the record survives a retain that keeps the file");
});

test("a kept file whose mtime changed is deleted and reported dirty", () => {
  const t = fixture();
  t.host("main.tex", "body");
  t.FS.mkdir(WORKROOT + "/chapters");
  t.host("chapters/one.tex", "one");
  t.FS.nodes.get(WORKROOT + "/chapters/one.tex").mtime = new Date(1234567890000);
  t.api.retainRoutine(["main.tex", "chapters/one.tex"]);
  assert.deepEqual(t.last().dirty, ["chapters/one.tex"]);
  assert.ok(!t.has("chapters/one.tex"), "the changed file is deleted");
  assert.ok(t.has("main.tex"), "an unchanged kept file is left alone");
});

test("a kept file whose size changed is deleted and reported dirty", () => {
  const t = fixture();
  t.host("main.tex", "abc");
  const mtime = t.FS.nodes.get(WORKROOT + "/main.tex").mtime;
  t.other("main.tex", "abcdef", mtime);
  t.api.retainRoutine(["main.tex"]);
  assert.deepEqual(t.last().dirty, ["main.tex"]);
  assert.ok(!t.has("main.tex"));
});

test("a kept file the host never wrote is deleted and reported dirty", () => {
  const t = fixture();
  t.other("extra.tex", "x");
  t.api.retainRoutine(["extra.tex"]);
  assert.deepEqual(t.last().dirty, ["extra.tex"]);
  assert.ok(!t.has("extra.tex"));
});

test("a kept file that does not exist is reported dirty", () => {
  const t = fixture();
  t.host("main.tex", "body");
  t.api.retainRoutine(["main.tex", "gone/missing.tex"]);
  assert.deepEqual(t.last(), { result: "ok", cmd: "retain", dirty: ["gone/missing.tex"] });
  assert.ok(t.has("main.tex"));
});

test("nested directories are walked, kept files survive and directories stay", () => {
  const t = fixture();
  t.FS.mkdir(WORKROOT + "/figs");
  t.FS.mkdir(WORKROOT + "/figs/deep");
  t.host("figs/deep/a.png", "a");
  t.host("figs/deep/b.png", "b");
  t.host("figs/c.png", "c");
  t.api.retainRoutine(["figs/deep/a.png"]);
  assert.deepEqual(t.last().dirty, []);
  assert.ok(t.has("figs/deep/a.png"));
  assert.ok(!t.has("figs/deep/b.png"));
  assert.ok(!t.has("figs/c.png"));
  assert.ok(t.FS.nodes.has(WORKROOT + "/figs"), "directories are not removed");
  assert.ok(t.FS.nodes.has(WORKROOT + "/figs/deep"), "nested directories are not removed");
});

test("records of files no longer kept are dropped", () => {
  const t = fixture();
  t.host("a.tex", "a");
  t.host("b.tex", "b");
  t.api.retainRoutine(["a.tex"]);
  assert.deepEqual(Object.keys(t.self._retainWrites), ["a.tex"]);
});

test("retain resets the heap checkpoints and preamble snapshot, as flushcache does", () => {
  const t = fixture();
  t.api.retainRoutine([]);
  assert.equal(t.calls.hcReset, 1);
  assert.equal(t.self._preambleFmtData, null);
  assert.equal(t.self._preambleInputFiles, null);
  assert.equal(t.self._preambleHash, "");
  assert.deepEqual(t.last(), { result: "ok", cmd: "retain", dirty: [] });
});

test("a malformed request replies failed and deletes nothing", () => {
  const t = fixture();
  t.host("main.tex", "body");
  t.api.retainRoutine(undefined);
  assert.equal(t.last().result, "failed");
  assert.equal(t.last().cmd, "retain");
  assert.equal(typeof t.last().error, "string");
  assert.ok(t.has("main.tex"), "nothing is deleted when the request is malformed");
  assert.equal(t.calls.hcReset, 0);
});

let passed = 0;
for (const { name, fn } of tests) {
  fn();
  passed++;
  console.log("ok - " + name);
}
console.log("retain.test.cjs: " + passed + " tests passed");
