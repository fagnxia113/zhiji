// Check inline Markdown file links in maintained docs. No network or anchor checks.
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const documents = ["README.md", "RELEASE.md"];

async function collect(directory) {
  for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      // Historical documents retain original references; only their index is maintained.
      if (path === join("docs", "archive")) documents.push(join(path, "README.md"));
      else await collect(path);
    } else if (entry.name.endsWith(".md")) documents.push(path);
  }
}

await collect("docs");
const failures = [];
let checked = 0;
for (const document of documents) {
  const content = await readFile(join(root, document), "utf8");
  let fence = null;
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    const marker = line.match(/^\s*(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
      continue;
    }
    if (fence) continue;
    const prose = line.replace(/(`+).*?\1/g, "");
    for (const match of prose.matchAll(/!?\[[^\]]*\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+"[^"]*")?\s*\)/g)) {
      const href = match[1] ?? match[2];
      if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(href)) continue;
      checked++;
      try {
        const path = decodeURIComponent(href.split(/[?#]/)[0]);
        const target = resolve(root, dirname(document), path);
        const local = relative(root, target);
        if (isAbsolute(path) || isAbsolute(local) || local === ".." || local.startsWith(`..${sep}`)) {
          throw new Error("link must stay within the repository");
        }
        await stat(target);
      } catch (error) {
        failures.push(`${document}:${index + 1}: ${href} (${error.message})`);
      }
    }
  }
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Documentation check passed: ${documents.length} documents, ${checked} local links.`);
}
