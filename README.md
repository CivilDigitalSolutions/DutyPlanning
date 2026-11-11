# Duty Planning

A Progressive Web App (PWA) that replaces the duty-planning spreadsheet. It works on phones and desktops, and you can install it to the home screen. It also works offline.

- **Planners** see the whole plan as a grid, with teams grouped down the side and dates across the top. Vacant posts appear as empty rows, and each team shows a count of people on duty per day. Planners edit cells directly.
- **Staff** see their own duties, their teammates' duties and everyone else's on the plan, and can add their duties to their phone calendar.

## Features

| Area | What it does |
| --- | --- |
| Plan grid | Teams grouped with establishment, filled posts and vacancies. Sticky names and dates. Weekend and today highlighting. Per-team and total on-duty counts, shown in red when a team drops below its minimum. Filter by team, name or staff number, or accreditation. You can show or hide staff numbers, accreditation columns and vacant rows. The grid shows 1 to 13 weeks at a time. |
| Editing (planners) | Click or drag to select cells, then tap a duty code in the palette. You can also type a code (`RD`, `T1`, `AL` …), and arrow keys move around the grid. Copy and paste works with Excel (tab-separated), and Ctrl+Z undoes changes. Planners can add notes to cells and apply repeating rota patterns to a team or the selected rows, optionally staggered per person. |
| My duties | Phone-first list of your coming weeks: today, next duty, next rest day, and leave and training counts. Tap a day to see who else is on and what your team is doing, with tap-to-call. Download your duties as a calendar file (`.ics`). |
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

This produces one self-contained HTML file that runs the whole app in the browser with sample data and no server. The API is swapped for an in-browser mock (`demo/mock-api.js`) that applies the same rules, and data is saved in that browser's local storage. Use it to share a preview. File downloads (Excel export, calendar file), live updates and offline caching are switched off in this build.

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
