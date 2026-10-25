#!/usr/bin/env node

import { writeFileSync } from "node:fs";

const API_VERSION = process.env.FB_API_VERSION || "v26.0";
const BASE = `https://graph.facebook.com/${API_VERSION}`;
const RETRYABLE = new Set([1, 2, 4, 17, 32, 613, 80001]);
const DELETABLE_EDGES = ["published_posts", "feed", "posts"];

const HELP = `Bulk-delete Facebook Page posts (Graph API - one DELETE call per post).

Usage:
  node scripts/fb-delete-posts.mjs pages  --user-token <token>
  node scripts/fb-delete-posts.mjs delete --page-token <token> [options]
  node scripts/fb-delete-posts.mjs delete --user-token <token> --page "<Page name>" [options]

Get a token (one-time, ~3 minutes):
  1. Open https://developers.facebook.com/tools/explorer/
  2. Create a test app if you do not have one yet.
  3. Add permissions: pages_show_list, pages_read_engagement, pages_manage_posts
  4. Click "Generate Access Token", pick your Facebook account, approve as Page admin.
  5. Run the "pages" command with that user token to see your Page token.

Commands:
  pages   List the Pages you manage, their tasks and Page access tokens.
  delete  Scan Page posts (dry run by default), add --yes to actually delete.

Options:
  --page <id|name>       Page to use with --user-token
  --before <YYYY-MM-DD>  Only touch posts created before this date
  --after <YYYY-MM-DD>   Only touch posts created after this date
  --limit <n>            Stop after n posts
  --delay <ms>           Pause between DELETE calls (default 300)
  --edge <name>          published_posts (default) | feed | posts
  --yes                  Actually delete. Without it nothing is deleted.
  --user-token <token>   Or set env FB_USER_TOKEN
  --page-token <token>   Or set env FB_PAGE_TOKEN

Notes:
  - Deletion is permanent. Run a dry run first. Before deleting, a JSON file with
    every post id, date, link and message text is saved to fb-posts-backup-*.json
    (a record only - Facebook cannot restore the posts from it).
  - Not deletable via API: Reels, profile/cover photos, story highlights,
    personal profile posts, group posts.
  - Leave --delay at 300+ ms. Too fast triggers page rate limits (error 80001).
`;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

function die(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function graph(path, { method = "GET", params = {}, token } = {}) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  if (token) url.searchParams.set("access_token", token);

  let res;
  try {
    res = await fetch(url, { method });
  } catch (err) {
    const e = new Error(`Network error: ${err.message}`);
    e.code = 0;
    throw e;
  }

  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }

  if (body && body.error) {
    const e = new Error(body.error.message);
    e.code = body.error.code;
    e.subcode = body.error.error_subcode;
    throw e;
  }
  if (!res.ok) {
    const e = new Error(`HTTP ${res.status}`);
    e.code = 0;
    throw e;
  }
  return body;
}

function tokenFrom(args, kind) {
  const fromFlag = kind === "user" ? args["user-token"] : args["page-token"];
  const fromEnv = kind === "user" ? process.env.FB_USER_TOKEN : process.env.FB_PAGE_TOKEN;
  const token = fromFlag || fromEnv;
  if (!token) {
    die(
      kind === "user"
        ? "Missing --user-token (or env FB_USER_TOKEN). Run with --help for the token setup steps."
        : "Missing --page-token (or env FB_PAGE_TOKEN). Run the 'pages' command first to get it.",
    );
  }
  return token;
}

async function listPages(userToken) {
  const body = await graph("/me/accounts", {
    params: { fields: "id,name,access_token,tasks", limit: 100 },
    token: userToken,
  });
  return body.data || [];
}

async function resolvePage(userToken, pageRef) {
  const pages = await listPages(userToken);
  if (pages.length === 0) {
    die(
      "This user token sees no Pages. Make sure the token has pages_show_list and that you approved it as a Page admin.",
    );
  }
  if (pageRef) {
    const ref = String(pageRef).toLowerCase();
    const matches = pages.filter(
      (p) => p.id === pageRef || p.name.toLowerCase() === ref || p.name.toLowerCase().includes(ref),
    );
    if (matches.length === 0) {
      die(`No page matching "${pageRef}". Available:\n` + pages.map((p) => `  ${p.id}  ${p.name}`).join("\n"));
    }
    if (matches.length > 1) {
      die(`"${pageRef}" matches several pages, use the id:\n` + matches.map((p) => `  ${p.id}  ${p.name}`).join("\n"));
    }
    return matches[0];
  }
  if (pages.length === 1) return pages[0];
  die(
    "Several pages found, pass --page <id or name>:\n" +
      pages.map((p) => `  ${p.id}  ${p.name}`).join("\n"),
  );
}

function makeDateFilter(args) {
  const before = args.before ? Date.parse(`${args.before}T00:00:00Z`) : null;
  const after = args.after ? Date.parse(`${args.after}T00:00:00Z`) : null;
  for (const [name, ts] of [["--before", before], ["--after", after]]) {
    if (args[name] && Number.isNaN(ts)) die(`${name} must be YYYY-MM-DD, got "${args[name]}"`);
  }
  return (post) => {
    const t = Date.parse(post.created_time);
    if (before && !(t < before)) return false;
    if (after && !(t > after)) return false;
    return true;
  };
}

async function collectPosts(token, pageId, args) {
  const edge = args.edge || "published_posts";
  if (!DELETABLE_EDGES.includes(edge)) {
    die(`--edge must be one of: ${DELETABLE_EDGES.join(", ")}`);
  }
  const keep = makeDateFilter(args);
  const limit = args.limit ? Number(args.limit) : Infinity;
  const seenIds = new Set();
  const seenCursors = new Set();
  const posts = [];
  let cursor = null;
  let scanned = 0;

  for (;;) {
    const params = { fields: "id,created_time,message,permalink_url", limit: 100 };
    if (cursor) params.after = cursor;

    let page;
    try {
      page = await graph(`/${pageId}/${edge}`, { params, token });
    } catch (err) {
      if (err.code === 190) die("Access token is invalid or expired. Generate a fresh one in Graph API Explorer.");
      die(`Failed to read posts: ${err.message} (code ${err.code})`);
    }

    const items = page.data || [];
    for (const item of items) {
      if (!item.id || seenIds.has(item.id)) continue;
      seenIds.add(item.id);
      scanned++;
      if (keep(item)) posts.push(item);
    }

    if (posts.length >= limit) {
      posts.length = limit;
      break;
    }

    const next = page.paging && page.paging.cursors && page.paging.cursors.after;
    if (!items.length || !next || seenCursors.has(next)) break;
    seenCursors.add(next);
    cursor = next;

    if (scanned % 1000 < 100) console.log(`  scanned ${scanned} posts, ${posts.length} match...`);
  }

  return posts;
}

function writeBackup(posts) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const file = `fb-posts-backup-${stamp}.json`;
  writeFileSync(file, JSON.stringify(posts, null, 2));
  return file;
}

async function deletePosts(token, posts, args) {
  const delay = args.delay !== undefined ? Number(args.delay) : 300;
  if (Number.isNaN(delay) || delay < 0) die("--delay must be a number of milliseconds");
  const deleted = [];
  const failed = [];
  let permissionErrors = 0;

  for (let i = 0; i < posts.length; i++) {
    const post = posts[i];
    let attempt = 0;
    for (;;) {
      try {
        await graph(`/${post.id}`, { method: "DELETE", token });
        deleted.push(post);
        break;
      } catch (err) {
        if (err.code === 190) {
          die("Access token expired mid-run. Generate a fresh token and re-run, already deleted posts stay deleted.");
        }
        if (RETRYABLE.has(err.code) && attempt < 4) {
          attempt++;
          await sleep(2000 * attempt);
          continue;
        }
        if ([10, 200, 283, 294].includes(err.code)) permissionErrors++;
        failed.push({ id: post.id, created_time: post.created_time, code: err.code, error: err.message });
        break;
      }
    }
    if ((i + 1) % 25 === 0 || i === posts.length - 1) {
      console.log(`  ${i + 1}/${posts.length} processed - ${deleted.length} deleted, ${failed.length} failed`);
    }
    if (delay > 0) await sleep(delay);
  }

  if (permissionErrors > 0 && permissionErrors === failed.length) {
    console.error(
      "\nEvery DELETE was refused for permission reasons. The token needs pages_manage_posts granted by a Page admin,\n" +
        "or the API does not allow deleting this kind of post. Check the Graph API Explorer token and retry.",
    );
  }

  return { deleted, failed };
}

function dateRangeLabel(posts) {
  if (!posts.length) return "";
  const times = posts.map((p) => Date.parse(p.created_time)).filter((t) => !Number.isNaN(t));
  const fmt = (t) => new Date(t).toISOString().slice(0, 10);
  return ` (${fmt(Math.min(...times))} .. ${fmt(Math.max(...times))})`;
}

async function cmdPages(args) {
  const token = tokenFrom(args, "user");
  let pages;
  try {
    pages = await listPages(token);
  } catch (err) {
    if (err.code === 190) die("User token is invalid or expired. Generate a fresh one in Graph API Explorer.");
    die(`Could not list pages: ${err.message} (code ${err.code})`);
  }
  if (!pages.length) {
    console.log("No pages found for this token.");
    return;
  }
  console.log(`Pages you can manage (via ${API_VERSION}):\n`);
  for (const p of pages) {
    console.log(`  ${p.name}`);
    console.log(`    id:    ${p.id}`);
    console.log(`    tasks: ${(p.tasks || []).join(", ")}`);
    console.log(`    token: ${p.access_token}`);
    console.log("");
  }
  console.log("Use a token above with: node scripts/fb-delete-posts.mjs delete --page-token <token> --yes");
  console.log("Never share these tokens - anyone with a Page token can modify your Page.");
}

async function cmdDelete(args) {
  let token;
  let pageId;
  let pageName = "";

  if (args["page-token"]) {
    token = tokenFrom(args, "page");
    const debug = await graph("/me", { params: { fields: "id,name" }, token }).catch(() => null);
    pageId = debug && debug.id;
    pageName = (debug && debug.name) || "";
    if (!pageId) {
      die("The page token did not identify a Page. Re-copy the token from the 'pages' command.");
    }
  } else {
    const userToken = tokenFrom(args, "user");
    const page = await resolvePage(userToken, args.page);
    token = page.access_token;
    pageId = page.id;
    pageName = page.name;
  }

  console.log(`Page: ${pageName || pageId} (${pageId}), edge: ${args.edge || "published_posts"}`);
  const posts = await collectPosts(token, pageId, args);
  console.log(`\n${posts.length} posts match.${dateRangeLabel(posts)}`);

  if (!posts.length) {
    console.log("Nothing to do.");
    return;
  }

  const sample = posts.slice(0, 3).map((p) => `  ${p.created_time}  ${(p.message || "(no text)").replace(/\n/g, " ").slice(0, 70)}`);
  console.log("Newest few:\n" + sample.join("\n"));

  if (!args.yes) {
    console.log("\nDRY RUN - nothing was deleted. Re-run with --yes to delete these posts permanently.");
    return;
  }

  const backup = writeBackup(posts);
  console.log(`\nBackup of post ids written to ${backup}`);
  console.log(`Deleting ${posts.length} posts...`);

  const { deleted, failed } = await deletePosts(token, posts, args);

  console.log(`\nDone: ${deleted.length} deleted, ${failed.length} failed.`);
  if (failed.length) {
    console.log("Failed posts:");
    for (const f of failed.slice(0, 20)) {
      console.log(`  ${f.id}  ${f.created_time}  code ${f.code}: ${f.error}`);
    }
    if (failed.length > 20) console.log(`  ...and ${failed.length - 20} more`);
    console.log("Re-run the same command to retry the leftovers.");
  }
}

const args = parseArgs(process.argv.slice(2));
const command = args._[0];

if (args.help || !command) {
  console.log(HELP);
  process.exit(args.help ? 0 : 1);
}

const run = async () => {
  if (command === "pages") return cmdPages(args);
  if (command === "delete") return cmdDelete(args);
  die(`Unknown command "${command}". Use: pages | delete\n\n${HELP}`);
};

run().catch((err) => die(err.message));
