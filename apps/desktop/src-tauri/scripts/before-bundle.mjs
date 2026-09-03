// zhnote is Windows-only; no pre-bundle shell hooks are needed.
// (The previous macOS icon-compile / dylib-fix scripts are no longer used.)
if (process.platform !== "win32") {
  console.log("[before-bundle] non-Windows platform, skipping.");
  process.exit(0);
}

console.log("[before-bundle] Windows detected, no pre-bundle hooks required.");
