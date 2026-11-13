# Duty Planning

A Progressive Web App (PWA) that replaces the duty-planning spreadsheet. It works on phones and desktops, and you can install it to the home screen. It also works offline.

- **Planners** see the whole plan as a grid, with teams grouped down the side and dates across the top. Vacant posts appear as empty rows, and each team shows a count of people on duty per day. Planners edit cells directly.
- **Staff** see their own duties, their teammates' duties and everyone else's on the plan, and can add their duties to their phone calendar.

## Features

| Area | What it does |
| --- | --- |
| Plan grid | Teams grouped with establishment, filled posts and vacancies. Sticky names and dates. Weekend and today highlighting. Per-team and total on-duty counts, shown in red when a team drops below its minimum. Filter by team, name or staff number, or accreditation. You can show or hide staff numbers, accreditation columns and vacant rows. The grid shows 1 to 13 weeks at a time. |
| Team positions | Each team can have one **team leader** (senior to supervisors) and any number of **supervisors**, who can come from any team: one person can lead or supervise several teams. Set them under Manage → Teams → Edit, on a person's record (*Team position*), or with the *Team position* column in the bulk user import. On the plan they're listed first in their team with **TL** / **SUP** badges, the team header names the team leader, and a team's daily count is underlined in amber on days the team is working with no team leader or supervisor on duty. Someone who leads or supervises **another team** gets an extra badge on their own row (e.g. **SUP·T2**) and also appears as a linked, view-only row at the top of the team they supervise (*from T1*, dashed and italic), so that team can see when they're on. Their duties are still edited on their own row (the linked row updates as they change), and they count only towards their own team's numbers. The Day view shows who is in charge of each team and lists cross-team leaders/supervisors under *From other teams*. |
| Daily postings | A finer layer on top of the plan: what each person on duty is actually doing that day (appointments, response driver, paperwork…), with an optional time and detail. Set in **Day → Postings** by that team's **team leader and supervisors** (and planners/admins). **Postings are private to each team**: people see only their own team's postings, plus any team they lead or supervise; planners and admins see every team. Includes *Copy from last working day* (only people on duty that day are posted) and *Give selected…* to post several people at once. Postings can also be viewed and edited **on the plan grid**: switch the plan from **Duties** to **Postings** to see each posting's short code in its colour (faint codes = on duty but not posted, greyed = day off, team rows = posted / on duty) and edit them exactly like duties (drag-select, palette, type a short code, *Time & detail*, copy/paste, undo). Postings never change the duty plan or counts. They show next to names in the Day view, in **My duties**, and as a small corner marker on plan cells (hover for the detail). Posting types (name, short code for the grid, colour) are managed under **Manage → Posting types**; types already used are hidden rather than deleted. |
| Editing (planners) | Click or drag to select cells, then tap a duty code in the palette. You can also type a code (`RD`, `T1`, `AL` …), and arrow keys move around the grid. Copy and paste works with Excel (tab-separated), and Ctrl+Z undoes changes. Planners can add notes to cells and apply repeating rota patterns to a team or the selected rows, optionally staggered per person. |
| My duties | Phone-first list of your coming weeks: today, next duty, next rest day, and leave and training counts. Tap a day to see who else is on and what your team is doing, with tap-to-call. Download your duties as a calendar file (`.ics`). |
| Annual leave | Staff request leave from the app and track where each request is up to. Their **line manager** approves or rejects it. A **leave administrator** then adds approved leave to the roster, and cancellations are handled the same way. See below. |
| Day view | Who is doing what on a given date, grouped by team or by duty, with an accreditation filter (for example, "who is first-aid qualified and on duty today"). |
| Accreditations | Any number of accreditation columns, each with an optional expiry date. Expired accreditations show in red and ones expiring within 60 days in amber. |
| Privacy | Codes can be marked **private** (for example, sickness). Colleagues see "unavailable" instead; only planners and the person can see the real code. Notes are visible only to planners and the person. You can limit mobile numbers to planners, the person's own team, or everyone. |
| Import and export | Upload the existing `.xlsx` or `.csv` and check a preview before anything is written. Export to `.xlsx` in the same layout, with duty colours, so files round-trip. |
| Live updates | When a planner saves a change, everyone viewing the plan sees it within a second or two. |
| Offline | The app and the last-viewed data are cached on the device. When offline, it shows the saved copy with a banner, and changes are blocked until you reconnect. |
| Accounts | Roles are admin, planner and staff. People sign in with their **email address** or staff number. Admins can bulk-import new users from a downloadable template (see below), or create staff logins for everyone already on the plan in one step. The app forces a password change at first sign-in. An activity log records every change. |

## Spreadsheet import format

The importer reads the layout you already use:

```
Staff No | Name | Initials | Mobile | [Team] | <accreditation columns…> | 01/12/2026 | 02/12/2026 | …
```

- **Identity columns** are recognised by header: *Staff No / Payroll No / Employee ID*, *Name*, *Initials*, *Mobile / Phone*, and optionally *Team*.
- **Date columns**: any header that is a date (real Excel dates, `dd/mm/yyyy`, `yyyy-mm-dd`, `Mon 5-Jan-26`, `5 January 2026` …). A second header row of weekday names is ignored. Choose day/month or month/day order when importing.
- **Every other header** is treated as an accreditation. A blank, `N`, `No` or `-` cell means not held; a date means held, with that expiry date.
- **Teams** come from either a *Team* column or heading rows that contain just the team name.
- **Vacancies**: blank rows (or rows whose name is `VACANT`) inside a team count as vacant posts. The team's establishment is set to people + vacancies.
- **Duty codes** not seen before (for example, `Training Course 3`) are created automatically. Set their colour and type afterwards under **Manage → Duty codes**.
- **Merge** mode updates people by staff number and replaces their duties for the dates in the file. **Replace** mode clears all teams, people and duties first.

## Annual leave

| Step | Who | What happens |
| --- | --- | --- |
| 1. Request | The person (Leave → My leave → Request leave) | Picks dates and a leave type. The form shows how many **working days** it covers (days they're rostered to work, or weekdays where nothing is planned yet), any clash with their other requests, and whether their team would drop below its minimum. |
| 2. Approve | Their **line manager** (Leave → To approve) | Approves, or rejects with a reason. They see the same day-by-day cover check. If someone has no line manager, an admin or leave administrator approves instead. Nobody can approve their own leave. |
| 3. Add to roster | A **leave administrator** (Leave → To add to roster) | Chooses the leave code (default AL) and checks a preview of every day, then adds it. Working days become **AL**, rest days become **Rest Day - AL** (`RD-AL`), and public holidays become **Public holiday - AL** (`PH-AL`). Existing leave such as sickness is left alone. The duties it replaced are remembered. |
| Cancel | The person | They can cancel while it's pending or approved. Once it's on the roster they **ask to cancel**, and a leave administrator removes it (their original duties are restored) or keeps it. |

**Leave lockdowns** (Manage → Leave lockdowns) are periods when leave needs extra control, such as a major operation. They can cover all teams or one team. During a lockdown, line managers can still approve leave, but **only someone who supervises the planners** (an account with the **Planner supervisor** tick box) can add it to the roster. Planners, admins and leave administrators can't; they see "needs a planner supervisor" instead of the button. Lockdowns are shown on the request form, on each request and its day-by-day breakdown, and as a red edge on the plan's date headers.

**Work queues and filters.** The *To approve*, *To add to roster* and *All requests* tabs share a filter bar, so a busy period can be worked through as a queue:

| Filter or option | What it does |
| --- | --- |
| Order | **Order received (oldest first)** is the default for the queues. Each request is numbered #1, #2… in that order, shows when it was received and how long it has waited (since approval, once approved). Other orders: newest first, date approved, leave start date, team, name, most working days. |
| Leave lockdown | A specific lockdown, any lockdown, or not in a lockdown. Use it to work through everyone waiting for one lockdown period. |
| Status, Team, Leave between, Search | Narrow by status (with counts), team, leave dates overlapping a range, or name / staff number. |
| Team clashes | Each request flags how many team-mates are off at the same time; tick *Only where team-mates are off at the same time* to see just those. |
| Bulk actions | Tick requests (or *Select all shown*) and **Approve selected** or **Add to roster selected**. They are processed in the order shown and any that can't be done are listed. |

Filters are remembered on each device per tab, and *Clear filters* resets them.

**Public holidays** are kept under Manage → Public holidays. **Add UK bank holidays** fills in a whole year for England and Wales, Scotland or Northern Ireland, including substitute days. One-off holidays (e.g. a coronation) are added by hand. Holidays are highlighted on the plan, Day view and My duties, and aren't counted as working days of leave.

**Set-up:**
- **Line manager** is a field on each person. Set it under Manage → People, under Manage → User accounts → Edit, or with the *Line manager email* column in the bulk import template.
- **Leave administrator** is a tick box on each user account (Manage → User accounts → Edit). Use it for whoever applies leave to the roster. Admins can always do it.
- **Planner supervisor** is another tick box on user accounts, for whoever supervises the planners. Only they can add leave that falls in a lockdown to the roster. Admins can tick it on their own account if they need to.
- The **Leave** tab shows a badge with the number of requests waiting for you. Every step is recorded on the request's history and in the activity log.

## Bulk importing new users

Under **Manage → User accounts → Import users** (admins only):

1. **Download the template**, either Excel (`.xlsx`, with dropdowns for Team and App role plus an *Instructions* sheet) or CSV.
2. **Fill in one row per person.** Only **Email** and a name are required.

   | Column | Notes |
   | --- | --- |
   | Email * | Becomes their sign-in name. Must be unique. |
   | First name, Last name / Full name | Give First + Last, or Full name. |
   | Staff No | If blank, one is generated (e.g. `U00042`). |
   | Initials | If blank, made from the name. |
   | Mobile | |
   | Team | Must match an existing team, unless "Create teams that don't exist yet" is ticked. |
   | Position in team | Order on the plan. Blank puts them at the end of the team. |
   | Job title | Rank, grade or job title. |
   | Start date | dd/mm/yyyy (or choose month/day order when uploading). |
   | Line manager email | The person who approves their leave. They can be elsewhere in the same file. |
   | Team position | `team leader` or `supervisor`; blank for a team member. One team leader per team. |
   | App role | `staff` (default), `planner` or `admin`. |
   | One column per accreditation | `Y` if held, or the expiry date. |

3. **Upload and check.** Every row is validated before anything is saved: bad or duplicate emails, missing names, unknown roles, unknown teams and staff numbers that belong to someone else are all flagged. Each row is shown as New, Update or Error.
4. **Import.** People already in the app (matched on email, then staff number) are updated; their passwords are never changed. New accounts get either the temporary password you enter, or a different generated one each. Generated passwords are shown once, with a button to copy them into Excel. Everyone must choose their own password at first sign-in. A team's establishment is raised if new starters take it over its post count.

The app does not send emails itself, so share temporary passwords through your usual secure channel. To send them automatically you could add Amazon SES.

## Running locally

Requires **Node.js 22.13 or later** (it uses the built-in `node:sqlite`, so no native modules are needed).

```bash
npm install
```

```bash
npm run seed:demo          # optional: 4 teams of demo data
```

```bash
ADMIN_PASSWORD=change-me-now npm start
```

Open http://localhost:3000. The demo logins are `admin / admin1234`, `planner / planner1234` and staff `1001 / staff1234`.

```bash
npm test                   # API and spreadsheet parser tests
```

### Standalone demo build

```bash
npm run build:demo        # -> dist/duty-planning-demo.html
```

This produces one self-contained HTML file that runs the whole app in the browser with sample data and no server, plus the GitHub Pages site in `dist/pages/`. The API is swapped for an in-browser mock (`demo/mock-api.js`) that applies the same rules, and data is saved in that browser's local storage. Live updates between users are switched off. The single HTML file can't download files (it's built for the Claude preview, which blocks downloads); the Pages site can.

### Demo on GitHub Pages (proof of concept)

`.github/workflows/pages.yml` runs the tests, builds the standalone demo (`dist/pages/`) and publishes it to GitHub Pages on every push to `main` or the development branch.

1. **Turn on Pages once:** repository **Settings → Pages → Build and deployment → Source: GitHub Actions**.
2. **Publish:** push, or run the *Deploy demo to GitHub Pages* workflow from the Actions tab.
3. **Share the link:** `https://<owner>.github.io/<repository>/`, also shown on the workflow run.

The demo runs entirely in the visitor's browser with sample teams; no server or real data is involved. Visitors pick Planner, Staff member or Admin on the sign-in screen. Their changes stay in their own browser, and the account menu has *Reset demo data*. It can be added to a phone's home screen and opens offline after the first visit. Downloads work: the Excel plan export, the new-users template (Excel and CSV) and the personal calendar file are built in the browser, using a copy of the Excel library served from the site itself. (The Claude artifact preview blocks downloads, so there these buttons explain what they would download instead.)

Things to know:
- **The site is public** and readable by anyone with the link, even from a private repository. Only GitHub Enterprise Cloud can restrict Pages access. It's marked `noindex` so search engines shouldn't list it.
- Pages on a **private** repository needs a paid GitHub plan (Pro, Team or Enterprise).

## Deploying to AWS (EC2)

The app is a single Node.js process with a SQLite database file. A small instance is plenty: a `t3.small` handles thousands of staff.

### Option A – Docker with automatic HTTPS (recommended)

1. **Launch an instance**: Amazon Linux 2023 or Ubuntu 24.04, `t3.small`, 20 GB gp3 disk.
   - Security group: allow inbound **80** and **443** from where users connect, and **22** only from your admin IP (or use SSM Session Manager instead).
2. **Give it a fixed address**: allocate an **Elastic IP** and attach it to the instance.
3. **Create a DNS record**: an `A` record such as `duties.yourorg.org` pointing at the Elastic IP (Route 53 or your DNS provider). HTTPS is required for the app to install as a PWA.
4. **Install Docker**:
   ```bash
   sudo dnf install -y docker git && sudo systemctl enable --now docker   # Amazon Linux
   ```
   Then install the Docker Compose plugin: https://docs.docker.com/compose/install/linux/
5. **Deploy**:
   ```bash
   git clone <this repo> /opt/dutyplanning && cd /opt/dutyplanning
   ```
   ```bash
   cp .env.example .env
   ```
   Edit `.env`: set `DOMAIN`, `ORG_NAME` and a strong `ADMIN_PASSWORD`. Then start the stack:
   ```bash
   sudo docker compose up -d --build
   ```
   Caddy obtains and renews a Let's Encrypt certificate for you.
6. **First sign-in**: sign in as `admin`, change the password, then go to **Manage → Import / export** and upload your spreadsheet. After that, use **User accounts → Create logins for everyone**.

**Updating:**

```bash
git pull
```

```bash
sudo docker compose up -d --build
```

Users' cached app refreshes automatically, because the service worker's version is derived from the front-end files.

### Option B – Node with systemd and nginx

1. Install Node.js 22 and nginx.
2. Copy the repo to `/opt/dutyplanning`, then run `npm ci --omit=dev`.
3. Create a `dutyplanning` system user and `/var/lib/dutyplanning`, owned by that user.
4. Copy `deploy/dutyplanning.service` into `/etc/systemd/system/`, then `systemctl enable --now dutyplanning`.
5. Copy `deploy/nginx.conf` into nginx's site configuration, then get a certificate with `certbot --nginx -d duties.yourorg.org`.

### Behind an AWS Application Load Balancer

This works as well: terminate TLS on the ALB with an ACM certificate and forward to port 3000. Set `TRUST_PROXY` to the ALB subnet range or `true`, and raise the ALB idle timeout (for example to 3600 s) so the live-update connection isn't dropped.

### Backups

The whole dataset is one file. Take consistent copies while the app runs:

```bash
docker compose exec app node --disable-warning=ExperimentalWarning scripts/backup.js /data/backups
```

Schedule that with cron and copy the backups to S3 (`aws s3 cp`). Also enable **EBS snapshots** of the volume through AWS Data Lifecycle Manager.

Lost admin password:

```bash
docker compose exec app node --disable-warning=ExperimentalWarning scripts/create-admin.js admin 'NewPassword123'
```

## Configuration (environment variables)

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | Listen address |
| `DB_FILE` | `./data/dutyplanning.db` | SQLite database path |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | `admin` / – | Initial admin, created only if no admin exists |
| `ORG_NAME` | `Duty Planning` | Name shown in the header |
| `MOBILE_VISIBILITY` | `team` | `all`, `team` or `planners` |
| `DATE_ORDER` | `dmy` | Default date order when importing |
| `COOKIE_SECURE` | `true` in production | Send the session cookie over HTTPS only |
| `TRUST_PROXY` | `loopback, uniquelocal` in production | Express trust-proxy setting, used for client IPs |

## Project layout

```
server/        Express API, auth, SQLite schema, spreadsheet import/export
demo/          In-browser mock API and sample data for the standalone demo build
public/        The PWA (no build step): index.html, sw.js, manifest, css/, js/views/
scripts/       Demo data, backup, admin reset, icon generation
deploy/        Caddyfile, nginx config, systemd unit
test/          node:test suites
```

## Security notes

- Passwords are hashed with scrypt. Sessions use random tokens stored hashed server-side in an HttpOnly, SameSite cookie, and last 30 days.
- State-changing requests require a custom header (CSRF protection). Login attempts are throttled.
- The app sends a strict Content-Security-Policy and does not use third-party scripts.
- Signing out clears the offline data cache on the device.
