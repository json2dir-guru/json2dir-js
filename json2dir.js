#!/usr/bin/env node
// json2dir: create the directory tree a JSON document describes, in the current directory.
// Implements RFC J2D-1 (https://github.com/kitsunoff/awesome-json2dir/blob/main/spec/rfc-json2dir.md).
"use strict";

const fs = require("node:fs");
const path = require("node:path");

class Json2dirError extends Error {}

const fail = (message) => {
  throw new Json2dirError(message);
};

// §3: strict UTF-8 and strict JSON. JSON.parse already rejects comments, trailing commas,
// NaN/Infinity and trailing data; a leading BOM is ignored, as §3 allows.
function parse(bytes) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("input is not valid UTF-8");
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    fail(`input is not valid JSON: ${e.message}`);
  }
}

// §4.2.1: names are used exactly; trailing "/" or "/." forms are rejected, not trimmed.
function checkName(name, where) {
  if (name === "" || name === "." || name === ".." || name.includes("/") || name.includes("\0"))
    fail(`${where}: invalid name ${JSON.stringify(name)}`);
}

function checkString(s, where) {
  // §3.5: a string with an unpaired surrogate cannot be encoded as UTF-8.
  if (!s.isWellFormed()) fail(`${where}: string contains an unpaired surrogate`);
}

// Members in ascending order of the UTF-8 bytes of their names, like the reference.
const byUtf8 = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));

// §4, §6: validate the whole document before touching the file system.
function validate(value, where) {
  if (typeof value === "string") return checkString(value, where);
  if (Array.isArray(value)) {
    if (value.length !== 2 || typeof value[0] !== "string" || typeof value[1] !== "string")
      fail(`${where}: an array must be ["link", target] or ["script", content]`);
    if (value[0] !== "link" && value[0] !== "script") fail(`${where}: unknown array kind ${JSON.stringify(value[0])}`);
    // §10: a link target with NUL cannot be created, so it is rejected before anything is written.
    if (value[0] === "link" && value[1].includes("\0")) fail(`${where}: a link target cannot contain NUL`);
    return checkString(value[1], where);
  }
  if (value !== null && typeof value === "object") {
    for (const name of Object.keys(value)) {
      const child = where === "." ? name : `${where}/${name}`;
      checkString(name, child);
      checkName(name, child);
      validate(value[name], child);
    }
    return;
  }
  fail(`${where}: ${value === null ? "null" : typeof value} values are not allowed`);
}

function lstatOrNull(p) {
  try {
    return fs.lstatSync(p);
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

// §5.2, §5.3: an existing non-directory is removed (a symlink itself, never its target);
// §5.4: a directory in the way of a non-object is an error.
function clear(p, existing) {
  if (!existing) return;
  if (existing.isDirectory()) fail(`${p}: a directory is in the way`);
  fs.unlinkSync(p);
}

function writeFile(p, content, executable) {
  // "wx" = O_CREAT | O_EXCL: never writes through an entry that appeared after clear().
  const fd = fs.openSync(p, "wx", 0o666);
  try {
    fs.writeFileSync(fd, content);
    if (executable) fs.fchmodSync(fd, (fs.fstatSync(fd).mode & 0o7777) | 0o111);
  } finally {
    fs.closeSync(fd);
  }
}

function apply(dir, tree) {
  for (const name of Object.keys(tree).sort(byUtf8)) {
    const p = path.join(dir, name);
    const value = tree[name];
    const existing = lstatOrNull(p);
    if (typeof value === "string") {
      clear(p, existing);
      writeFile(p, value, false);
    } else if (Array.isArray(value)) {
      clear(p, existing);
      if (value[0] === "link") fs.symlinkSync(value[1], p);
      else writeFile(p, value[1], true);
    } else {
      if (!existing || !existing.isDirectory()) {
        if (existing) fs.unlinkSync(p);
        fs.mkdirSync(p);
      }
      apply(p, value);
    }
  }
}

function main(args) {
  if (args.length > 0) {
    process.stderr.write("usage: json2dir < document.json\n");
    return 2;
  }
  try {
    const document = parse(fs.readFileSync(0));
    if (document === null || typeof document !== "object" || Array.isArray(document))
      fail("the root of the document must be an object");
    validate(document, ".");
    apply(".", document);
    return 0;
  } catch (e) {
    process.stderr.write(`json2dir: ${e instanceof Json2dirError ? e.message : e.message || e}\n`);
    return 1;
  }
}

process.exitCode = main(process.argv.slice(2));
