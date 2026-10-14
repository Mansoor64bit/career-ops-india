# Career-Ops India & Startup Scanner — Deployment & Daily Run Guide

This guide documents the setup, architecture, and exact daily manual commands to run the **Indian Startup ATS Scanner** and **ATS Resume Generator** (`career-ops-india`) directly from your primary `job-hunter` project or as a standalone sidecar.

---

## 1. Architecture Overview

- **Core Engine:** Standalone Node.js scanner querying public ATS APIs (Greenhouse, Lever, Ashby) for 250+ Indian startups.
- **Zero Cost:** 100% free. No paid API keys, zero scrapers, zero Cloudflare/CAPTCHA risks.
- **Decoupled Design:** Runs in parallel to `job-hunter` without polluting the Python virtual environment or breaking existing unit tests.
- **Strict Matching Pipeline:**
  - **Freshness Window:** Default **last 24 hours** (configurable to 72h or all-dates).
  - **Experience Level:** Strictly **0–1 YOE** (entry-level). Blocks 22+ senior titles (`Senior`, `Lead`, `Manager`, `Director`, `VP`, `Associate Director`, `CA Qualified`).
  - **Preferred Cities Only:** Bangalore / Bengaluru, Mumbai / Navi Mumbai / Thane, Pune, Hyderabad, Chennai, Kochi, Coimbatore, and India Remote.
  - **Domain Filter:** Rejects BPO, bookkeeping, AP/AR, sales, telecalling, and rotational night shifts.

---

## 2. Quick Setup & Verification (One-Time)

The sidecar is installed at `c:\Users\LIG3\Downloads\career-ops-india`.

### Verify System Health
Run the built-in diagnostic doctor from the `career-ops-india` directory:
```powershell
cd c:\Users\LIG3\Downloads\career-ops-india
npm run doctor
```
*Expected: 19/19 setup checks passed.*

---

## 3. Daily Manual Execution (Choose Option A or Option B)

### Option A: From Primary Workspace (`job-hunter`) [Recommended]

You can execute all startup scans directly from your `job-hunter` terminal without changing directories.

```powershell
cd c:\Users\LIG3\Downloads\job-hunter
```

#### Command 1: Daily Morning Pulse (Last 24 Hours)
Scans all 259 Indian startup ATS boards for fresh entry-level finance roles posted in the last 24h:
```powershell
.\scan_startups.ps1
```

#### Command 2: Monday / Weekend Catch-up (Last 72 Hours)
Catches jobs posted over the weekend or past 3 days:
```powershell
.\scan_startups.ps1 --hours=72
```

#### Command 3: Full Inventory Check (All Active Open Listings)
Date-unrestricted scan—surfaces every active entry-level finance role currently open:
```powershell
.\scan_startups.ps1 --all-dates
```

---

### Option B: From Sidecar Directory (`career-ops-india`)

```powershell
cd c:\Users\LIG3\Downloads\career-ops-india
```

#### Command 1: Daily 24-Hour Scan
```powershell
npm run scan
```

#### Command 2: 72-Hour Scan
```powershell
npm run scan -- --hours=72
```

#### Command 3: All Active Open Listings
```powershell
npm run scan -- --all-dates
```

#### Command 4: Single ATS Board Only (Optional)
Filter by a specific ATS platform:
```powershell
npm run scan -- --board=greenhouse
npm run scan -- --board=lever
npm run scan -- --board=ashby
```

---

## 4. On-Demand Tools

### Instant Tailored ATS Resume Generator (PDF)
Converts your [`cv.md`](file:///c:/Users/LIG3/Downloads/career-ops-india/cv.md) into an ATS-compliant, single-column PDF resume branded for a target company:

```powershell
cd c:\Users\LIG3\Downloads\career-ops-india
npm run pdf -- --company <company_name> --role <role_slug>
```

**Real Examples:**
```powershell
# For Razorpay Junior Analyst role:
npm run pdf -- --company razorpay --role junior-analyst

# For Paytm Risk Analyst role:
npm run pdf -- --company paytm --role risk-analyst
```
*Output saved to:* `c:\Users\LIG3\Downloads\career-ops-india\output\mansoor-makandar_<company>_<role>_<date>.pdf` (File size: ~52 KB, text-only, ATS safe).

---

## 5. Output Locations & Files

| What | Path | Description |
| :--- | :--- | :--- |
| **Terminal Output** | On-screen | Instant scannable table with company, title, location, posted age, and clickable application link. |
| **Raw JSON Results** | `career-ops-india/data/scan_results.json` | Complete metadata of all matched jobs from the latest run. |
| **Candidate Config** | `career-ops-india/config/profile.yml` | Candidate preferences, target roles, salary floor, city list, and negative keywords. |
| **Candidate Master CV**| `career-ops-india/cv.md` | Quantified Markdown master CV used for resume generation. |
| **Generated Resumes** | `career-ops-india/output/` | Generated company-specific PDFs ready for job applications. |
| **Root Runner** | `job-hunter/scan_startups.ps1` | One-click PowerShell forwarder script in the core workspace. |

---

## 6. Daily Workflow Routine (Cheat Sheet)

```text
[Every Morning ~9:00 AM IST]
  1. Open terminal in c:\Users\LIG3\Downloads\job-hunter
  2. Run: .\scan_startups.ps1
  3. If 0 jobs found today (strict 24h), run: .\scan_startups.ps1 --hours=72
  4. Found an active job link?
     - Inspect the link in your browser.
     - Generate tailored PDF:
       npm --prefix ..\career-ops-india run pdf -- --company <company> --role <role>
     - Submit application on company ATS portal.
```

---

## 7. Troubleshooting & FAQs

- **Q: Why does `.\scan_startups.ps1` return 0 jobs today?**  
  *A:* Startups don't post every single day. A return of `0` in a 24-hour window means no new roles opened today. Use `--hours=72` to catch roles from the last 3 days.
- **Q: Why are some companies reported as unreachable?**  
  *A:* Upstream lists ~250 startup slugs; companies change ATS providers or shut down endpoints over time. The scanner gracefully skips unreachable slugs without crashing.
- **Q: Does this modify any files in `job-hunter`?**  
  *A:* No. `job-hunter`'s core Python pipeline, `.venv`, tests, and Google Sheets integrations remain completely untouched and independent.
