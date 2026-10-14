#!/usr/bin/env node
/**
 * scripts/scan.mjs - career-ops-india portal scanner (Hardened & Synced with job-hunter)
 * 
 * Hits Greenhouse, Lever, and Ashby ATS APIs for verified Indian companies.
 * Zero LLM tokens. Zero scraping. Clean JSON responses.
 * 
 * Strict Filters:
 *   - Freshness: Default <= 24 hours (configurable via --hours=X or --all-dates)
 *   - Seniority: Excludes Sr/Lead/Manager/Director/VP/CA-qualified roles
 *   - Domain: Excludes BPO, bookkeeping, AP/AR, sales, telecalling
 *   - Location: Strictly preferred hubs (Bangalore, Mumbai, Pune, Hyderabad, Chennai, Kochi, Coimbatore, India Remote)
 *   - Experience: Entry level (0-1 YOE)
 */

import fs from "fs";
import path from "path";
import yaml from "js-yaml";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

// ── Config loader ─────────────────────────────────────────────────────────────
function readConfig() {
  const p = path.join(ROOT, "config/profile.yml");
  if (!fs.existsSync(p)) {
    console.error("❌ config/profile.yml not found. Run: npm run doctor");
    process.exit(1);
  }
  const cfg = yaml.load(fs.readFileSync(p, "utf8"));
  return {
    candidate: cfg.candidate || {},
    roles: (cfg.candidate?.target_roles || []).map(r => r.trim()),
    search: cfg.search || {},
    skills: cfg.candidate?.skills || []
  };
}

// ── Portals loader ────────────────────────────────────────────────────────────
function readPortals() {
  const p = path.join(ROOT, "portals/india.yml");
  if (!fs.existsSync(p)) return { greenhouse: [], lever: [], ashby: [] };
  const data = yaml.load(fs.readFileSync(p, "utf8")) || {};
  return {
    greenhouse: data.greenhouse || [],
    lever: data.lever || [],
    ashby: data.ashby || []
  };
}

// ── ATS fetchers ──────────────────────────────────────────────────────────────
async function fetchGreenhouse(slug) {
  try {
    const res = await fetch(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`,
      { headers: { "User-Agent": "Mozilla/5.0 (career-ops-india)" }, signal: AbortSignal.timeout(12000) });
    if (!res.ok) return { jobs: [], err: `HTTP ${res.status}` };
    const d = await res.json();
    return { jobs: d.jobs || [] };
  } catch(e) { return { jobs: [], err: e.message }; }
}

async function fetchLever(slug) {
  try {
    const res = await fetch(`https://api.lever.co/v0/postings/${slug}?mode=json`,
      { headers: { "User-Agent": "Mozilla/5.0 (career-ops-india)" }, signal: AbortSignal.timeout(12000) });
    if (!res.ok) return { jobs: [], err: `HTTP ${res.status}` };
    const d = await res.json();
    return { jobs: Array.isArray(d) ? d : [] };
  } catch(e) { return { jobs: [], err: e.message }; }
}

async function fetchAshby(slug) {
  try {
    const res = await fetch(`https://api.ashbyhq.com/posting-api/job-board/${slug}`,
      { headers: { "User-Agent": "Mozilla/5.0 (career-ops-india)", "Accept": "application/json" },
        signal: AbortSignal.timeout(12000) });
    if (!res.ok) return { jobs: [], err: `HTTP ${res.status}` };
    const d = await res.json();
    return { jobs: d.jobPostings || [] };
  } catch(e) { return { jobs: [], err: e.message }; }
}

// ── Normalizers ───────────────────────────────────────────────────────────────
function normGH(j, co) {
  const loc = j.location?.name || "";
  const dt = j.updated_at || j.created_at || null;
  return {
    source: "greenhouse",
    company: co.name,
    tier: co.tier || "2",
    title: (j.title || "").trim(),
    location: loc.trim() || "India",
    url: j.absolute_url || `https://boards.greenhouse.io/${co.slug}/jobs/${j.id}`,
    posted_at: dt ? new Date(dt).toISOString() : null,
    department: j.departments?.[0]?.name || "",
    remote: loc.toLowerCase().includes("remote"),
    snippet: (j.content || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 500)
  };
}

function normLV(j, co) {
  const loc = j.categories?.location || j.workplaceType || "";
  return {
    source: "lever",
    company: co.name,
    tier: co.tier || "2",
    title: (j.text || "").trim(),
    location: loc.trim() || "India",
    url: j.hostedUrl || j.applyUrl || "",
    posted_at: j.createdAt ? new Date(j.createdAt).toISOString() : null,
    department: j.categories?.department || "",
    remote: loc.toLowerCase().includes("remote"),
    snippet: (j.descriptionPlain || "").replace(/\s+/g, " ").trim().slice(0, 500)
  };
}

function normAB(j, co) {
  const loc = j.locationName || j.jobPostingLocations?.[0]?.locationName || "";
  return {
    source: "ashby",
    company: co.name,
    tier: co.tier || "2",
    title: (j.title || "").trim(),
    location: loc.trim() || "India",
    url: `https://jobs.ashbyhq.com/${co.slug}/${j.id}`,
    posted_at: j.publishedAt ? new Date(j.publishedAt).toISOString() : null,
    department: j.departmentName || "",
    remote: !!(j.isRemote || loc.toLowerCase().includes("remote")),
    snippet: (j.descriptionHtml || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 500)
  };
}

// ── Filtering Engine (mirrors job-hunter common.py) ───────────────────────────
function buildRegex(terms) {
  if (!terms || !terms.length) return null;
  const escaped = terms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  return new RegExp(`(?<!\\w)(${escaped})(?!\\w)`, "i");
}

function isFresh(postedAt, maxHours) {
  if (!postedAt) return { fresh: true, ageHours: null }; // Unknown date kept with flag
  const dt = new Date(postedAt);
  if (isNaN(dt.getTime())) return { fresh: true, ageHours: null };
  const ageMs = Date.now() - dt.getTime();
  const ageHours = Math.round((ageMs / (1000 * 60 * 60)) * 10) / 10;
  // 1-hour tolerance for boundary differences
  return {
    fresh: ageHours <= (maxHours + 1.0),
    ageHours
  };
}

function checkLocation(locStr, searchCfg) {
  const loc = (locStr || "").toLowerCase();
  
  // Exclude foreign remotes
  const foreignTerms = ["london", "united kingdom", " uk", "uk ", " us ", "usa", "united states", "emea", "europe", "germany", "berlin", "singapore", "australia", "canada", "toronto"];
  if (foreignTerms.some(f => loc.includes(f))) return false;

  // Check preferred cities & synonyms
  const allowed = [
    "bangalore", "bengaluru", "mumbai", "navi mumbai", "thane", "bombay",
    "pune", "pimpri", "hyderabad", "secunderabad", "chennai", "madras",
    "kochi", "cochin", "ernakulam", "coimbatore"
  ];
  if (allowed.some(c => loc.includes(c))) return true;

  // Remote handling
  if (searchCfg.allow_remote && loc.includes("remote")) {
    return true;
  }

  // Reject unlisted cities (e.g. Gurgaon, Delhi, Noida, Ahmedabad, Kolkata)
  return false;
}

function parseExperience(text) {
  if (!text) return null;
  const mRange = text.match(/(\d+(?:\.\d+)?)\s*(?:-|–|—|to)\s*(\d+(?:\.\d+)?)\s*\+?\s*(?:years|yrs|year|yr)/i);
  if (mRange) return { min: parseFloat(mRange[1]), max: parseFloat(mRange[2]) };
  const mPlus = text.match(/(\d+(?:\.\d+)?)\s*(\+)?\s*(?:years|yrs|year|yr)/i);
  if (mPlus) return { min: parseFloat(mPlus[1]), max: mPlus[2] ? 99 : parseFloat(mPlus[1]) };
  return null;
}

function matches(job, roles, searchCfg, maxHours, allDates = false) {
  const t = job.title;
  const desc = job.snippet;

  // 1. Freshness check
  const { fresh, ageHours } = isFresh(job.posted_at, maxHours);
  job.age_hours = ageHours;
  if (!allDates && !fresh) {
    return { ok: false, reason: `stale (${ageHours}h > ${maxHours}h)` };
  }

  // 2. Title Seniority exclusion
  const badWords = buildRegex(searchCfg.exclude_title_words);
  if (badWords && badWords.test(t)) {
    return { ok: false, reason: "senior/lead role" };
  }

  // 3. Excluded role types (sales, BPO, AP/AR, telecaller)
  const badTitles = buildRegex(searchCfg.exclude_title_keywords);
  if (badTitles && badTitles.test(t)) {
    return { ok: false, reason: "excluded job domain" };
  }

  // 4. Excluded description terms (rotational shifts, night shift, commission only)
  const badDesc = buildRegex(searchCfg.exclude_description_keywords);
  if (badDesc && badDesc.test(desc)) {
    return { ok: false, reason: "excluded shift/work type" };
  }

  // 5. Location check (preferred cities only)
  if (!checkLocation(job.location, searchCfg)) {
    return { ok: false, reason: `location outside preferred hubs (${job.location})` };
  }

  // 6. Experience filter (max 1 year)
  const expTitle = parseExperience(t);
  const expDesc = parseExperience(desc);
  const exp = expTitle || expDesc;
  if (exp && exp.min > (searchCfg.max_experience_years || 1)) {
    return { ok: false, reason: `requires ${exp.min}+ YOE` };
  }

  // 7. Role / Finance Title Match
  const titleLower = t.toLowerCase();
  const titleWords = new Set(titleLower.match(/[a-z0-9&+#.]+/g) || []);
  
  let isRoleMatch = false;
  for (const r of roles) {
    const rLower = r.toLowerCase();
    if (titleLower.includes(rLower)) {
      isRoleMatch = true;
      break;
    }
    const rWords = new Set(rLower.match(/[a-z0-9&+#.]+/g) || []);
    let overlap = 0;
    for (const w of rWords) {
      if (titleWords.has(w)) overlap++;
    }
    if (overlap / rWords.size >= 0.75) {
      isRoleMatch = true;
      break;
    }
  }

  // Check finance skill density if title is broad analyst/associate
  if (!isRoleMatch) {
    const financeSkills = [
      "fp&a", "financial planning", "financial modelling", "financial modeling",
      "3-statement", "dcf", "valuation", "budgeting", "forecasting", "variance analysis",
      "equity research", "credit analysis", "ratio analysis", "corporate finance"
    ];
    const descLower = desc.toLowerCase();
    const hits = financeSkills.filter(s => descLower.includes(s)).length;
    const isAnalystOrAssociate = /\b(analyst|associate|trainee|specialist|graduate)\b/i.test(t);
    if (hits >= 2 && isAnalystOrAssociate) {
      isRoleMatch = true;
    }
  }

  if (!isRoleMatch) {
    return { ok: false, reason: "title not matching finance target" };
  }

  return { ok: true, reason: "" };
}

// ── CLI & Execution ───────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const boardFilter = args.find(a => a.startsWith("--board="))?.split("=")[1];
const jsonMode = args.includes("--json");
const allDates = args.includes("--all-dates") || args.includes("--freshness=all");
const hoursArg = args.find(a => a.startsWith("--hours="))?.split("=")[1];

const { candidate, roles, search } = readConfig();
const maxHours = hoursArg ? parseInt(hoursArg, 10) : (search.freshness_hours || 24);
const portals = readPortals();
const results = [], errors = [];

if (!jsonMode) {
  console.log(`\n======================================================`);
  console.log(`🚀 career-ops-india Portal Scanner (Strict Match Engine)`);
  console.log(`   Candidate:        ${candidate.name || "Mansoor Makandar"}`);
  console.log(`   Freshness Window: ${allDates ? "ALL DATES (unrestricted)" : `Last ${maxHours} Hours`}`);
  console.log(`   Max Experience:   ${search.max_experience_years || 1} Year (Entry Level)`);
  console.log(`   Preferred Cities: Bangalore, Mumbai, Pune, Hyderabad, Chennai, Kochi, Coimbatore, Remote`);
  console.log(`   Target Roles:     ${roles.slice(0, 5).join(", ")} (+${Math.max(0, roles.length - 5)} more)`);
  console.log(`   ATS Companies:    ${portals.greenhouse.length + portals.lever.length + portals.ashby.length}`);
  console.log(`======================================================\n`);
}

async function scanBoard(name, companies, fetcher, normalizer) {
  if (boardFilter && boardFilter !== name) return;
  if (!jsonMode) process.stdout.write(`Scanning ${companies.length} ${name} companies... `);
  const tasks = companies.map(async co => {
    if (co.note?.includes("current employer")) return;
    const { jobs, err } = await fetcher(co.slug);
    if (err) { errors.push({ company: co.name, error: err }); return; }
    
    let matchedCo = 0;
    for (const raw of jobs) {
      const norm = normalizer(raw, co);
      const res = matches(norm, roles, search, maxHours, allDates);
      if (res.ok) {
        matchedCo++;
        results.push(norm);
      }
    }
    if (matchedCo && !jsonMode) process.stdout.write(`${co.name}(${matchedCo}) `);
  });
  await Promise.allSettled(tasks);
  if (!jsonMode) console.log("✓");
}

await scanBoard("greenhouse", portals.greenhouse, fetchGreenhouse, normGH);
await scanBoard("lever",      portals.lever,      fetchLever,      normLV);
await scanBoard("ashby",      portals.ashby,      fetchAshby,      normAB);

// Dedup by title + company
const seen = new Set();
const unique = results.filter(j => {
  const key = `${j.title.toLowerCase().trim()}|${j.company.toLowerCase().trim()}`;
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
});

// Sort: Tier 1 first, then freshest
unique.sort((a, b) => {
  if (a.tier === "1" && b.tier !== "1") return -1;
  if (a.tier !== "1" && b.tier === "1") return 1;
  const dtA = a.posted_at ? new Date(a.posted_at).getTime() : 0;
  const dtB = b.posted_at ? new Date(b.posted_at).getTime() : 0;
  return dtB - dtA;
});

// Save scan results
const dataDir = path.join(ROOT, "data");
fs.mkdirSync(dataDir, { recursive: true });
const out = {
  scanned_at: new Date().toISOString(),
  freshness_window_hours: allDates ? "all" : maxHours,
  max_experience_years: search.max_experience_years || 1,
  total: unique.length,
  errors: errors.length,
  jobs: unique
};
fs.writeFileSync(path.join(dataDir, "scan_results.json"), JSON.stringify(out, null, 2));

if (jsonMode) {
  console.log(JSON.stringify(out));
  process.exit(0);
}

console.log(`\n──────────────────────────────────────────────────────`);
console.log(`🎯 ${unique.length} verified matching jobs found | ${errors.length} companies unreachable`);
console.log(`──────────────────────────────────────────────────────\n`);

if (unique.length === 0) {
  console.log(`No jobs found posted within the last ${maxHours} hours matching entry-level finance roles.`);
  console.log(`Tip: Run with --all-dates to inspect older or all-time open listings:\n  npm run scan -- --all-dates\n`);
  process.exit(0);
}

const tier1 = unique.filter(j => j.tier === "1");
const tier2 = unique.filter(j => j.tier !== "1");

if (tier1.length) {
  console.log(`🌟 Tier 1 Matches (${tier1.length}):`);
  tier1.forEach((j, i) => {
    const ageStr = j.age_hours !== null ? `${j.age_hours}h ago` : "date unknown";
    console.log(`  ${i + 1}. [Tier 1] ${j.company.padEnd(16)} | ${j.title}`);
    console.log(`     📍 ${j.location} | ⏱️  ${ageStr} | 🔗 ${j.url}\n`);
  });
}

if (tier2.length) {
  console.log(`📌 Tier 2 Matches (${tier2.length}):`);
  tier2.forEach((j, i) => {
    const ageStr = j.age_hours !== null ? `${j.age_hours}h ago` : "date unknown";
    console.log(`  ${i + 1}. [Tier 2] ${j.company.padEnd(16)} | ${j.title}`);
    console.log(`     📍 ${j.location} | ⏱️  ${ageStr} | 🔗 ${j.url}\n`);
  });
}
