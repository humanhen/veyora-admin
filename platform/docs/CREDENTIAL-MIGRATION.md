# Customer credential migration — runbook

One-time migration that lets existing customers keep signing in with the passwords held in the
employer's credential workbook.

---

## The rules, before anything else

1. **The workbook never leaves your own machine.** Never upload it to GitHub, Claude, ChatGPT, a
   chat window, email, Slack, a ticket, a shared drive or any other channel. Not "just the
   headers". Not a screenshot.
2. **Never copy the workbook to the VPS.** Not to `/opt/veyora`, not to `/tmp`, not inside a
   container. It has no reason to be there and no way to be removed cleanly if it is.
3. **Only hashed data crosses the network**, and only through SSH stdin. The payload contains
   bcrypt hashes; there is no plaintext field in it, and both scripts refuse to run if one appears.
4. **Never save the payload to disk.** `--stdout` exists to be piped. Do not `> payload.json`.
   A file on disk is a file someone can copy, back up or commit by accident.
5. **Back up the database before the production apply**, and keep the dump off-host.
6. **Verify real logins and historical orders afterwards** before telling any customer anything.

The workbook lives outside the repository. Keep it there. It is not in `.gitignore` because it
was never inside the repo to begin with, and it must stay that way.

---

## What the pipeline does

```
  YOUR WINDOWS MACHINE                    │        THE SERVER
                                          │
  workbook.xlsx                           │
      │ read locally                      │
      ▼                                   │
  validate headers + rows                 │
      │                                   │
      ▼                                   │
  bcrypt.hash(password, 10)   ◄─ plaintext dies here, in memory, never written
      │                                   │
      ▼                                   │
  JSON payload of HASHES ───── ssh stdin ─┼──► apply script (inside the API container)
      (stdout)                            │        │
                                          │        ├─ plan against live PostgreSQL
  progress + counts (stderr)              │        └─ --dry-run  report only
                                          │           --apply    one transaction
```

The prepare script runs **only** on your machine. The apply script runs **only** in the
container, uses only production dependencies, and never hashes anything — the hashes arrive
already made.

---

## 0. One-time check

```bash
cd platform/server/api
npm test                                  # 486 tests, all green
```

The built-in reader handles ordinary `.xlsx` files. If your workbook defeats it, the script says
so and you can install a more tolerant reader **locally only**:

```bash
npm i -D exceljs                          # local machine only, never committed
```

The prepare script picks it up automatically if present. It is not a dependency of this project
and never reaches the production image.

---

## 1. Local validation (no server involved)

Confirm the workbook parses, the headers are right and every row is usable. Send the payload to
`/dev/null` — you only want the report on stderr.

```bash
cd platform/server/api
node scripts/prepare-credential-migration.mjs \
  --file "D:/path/to/your/workbook.xlsx" --stdout > /dev/null
```

Windows PowerShell:

```powershell
node scripts/prepare-credential-migration.mjs `
  --file "D:\path\to\your\workbook.xlsx" --stdout > $null
```

Read the stderr report. Fix any unusable rows in the workbook before going further. A duplicate
email address is fatal and must be resolved in the sheet — the script will not guess which
password is current.

Required headers, exactly and in this order:

```
id | external_id | business_name | email | password
```

---

## 2. RC dry run

Nothing is written. This is the plan you approve.

```bash
node scripts/prepare-credential-migration.mjs --file "D:/path/to/your/workbook.xlsx" --stdout |
  ssh veyora-vps "docker exec -i veyora_rc-api-1 \
    node scripts/apply-credential-migration.mjs --dry-run"
```

Check the counts. In particular:

| Line | What to do about it |
|---|---|
| `exactEmailMatches` | the normal path — nothing to do |
| `safePlaceholderBusinessMatches` | an `@import.veyora.local` account gains its real email |
| `pendingToActivate` | those customers can sign in immediately after the apply |
| `placeholderSuppliedEmails` | login will work, **email will not** — see below |
| `disabledSkips` | intentional; a disabled account is never reactivated |
| `roleMismatchSkips` | a staff account shares that address — investigate before release |
| `ambiguousSkips` | read each reason; these need a human decision |
| `missingAccounts` | no account exists; see §6 before considering `--create-missing` |

**Placeholder supplied emails.** Where the workbook itself supplies an `@import.veyora.local`
address, the password is still set and the account still activates, so the customer's existing
login keeps working. But activation emails, password reset and order notifications cannot reach
them until a real address is on file. The dry run lists these rows separately — give the list to
the client.

---

## 3. RC apply

Only after the dry-run plan is approved.

```bash
node scripts/prepare-credential-migration.mjs --file "D:/path/to/your/workbook.xlsx" --stdout |
  ssh veyora-vps "docker exec -i veyora_rc-api-1 \
    node scripts/apply-credential-migration.mjs --apply"
```

Everything happens in one transaction. If any single row does not update exactly one record, the
whole thing rolls back and nothing changes. User ids — and therefore every historical order — are
preserved.

Running the same workbook twice is refused, because it would overwrite any password a customer
has changed since. If you genuinely mean to re-run it, add `--force`.

---

## 4. RC login verification

Prove it actually works, on at most five accounts.

```bash
node scripts/verify-credential-logins.mjs \
  --file "D:/path/to/your/workbook.xlsx" \
  --base-url https://<rc-host> --count 3
```

Or specific rows:

```bash
node scripts/verify-credential-logins.mjs \
  --file "D:/path/to/your/workbook.xlsx" \
  --base-url https://<rc-host> --rows 2,17,84
```

This performs **real sign-ins**: it updates `last_login_at`, `prev_login_at` and writes an audit
entry for each account it touches. Passwords are never printed and emails are masked.

Then check by hand, in the admin panel:

- the customer's **historical orders are still listed** against them;
- their customer number, pricing profile, agent and balance are unchanged;
- an `@import.veyora.local` account that gained a real email shows the new address.

---

## 5. Production

**Take a fresh backup first and copy it off the host.**

```bash
ssh veyora-vps "cd /opt/veyora && docker compose exec -T db \
  pg_dump -U veyora veyora | gzip > /opt/veyora/pre-credential-migration.sql.gz"
scp veyora-vps:/opt/veyora/pre-credential-migration.sql.gz ./
```

Dry run:

```bash
node scripts/prepare-credential-migration.mjs --file "D:/path/to/your/workbook.xlsx" --stdout |
  ssh veyora-vps "docker exec -i veyora-api-1 \
    node scripts/apply-credential-migration.mjs --dry-run"
```

Apply:

```bash
node scripts/prepare-credential-migration.mjs --file "D:/path/to/your/workbook.xlsx" --stdout |
  ssh veyora-vps "docker exec -i veyora-api-1 \
    node scripts/apply-credential-migration.mjs --apply"
```

Then repeat §4 against production, with `--allow-production` (the tool refuses a
production-looking host without it) and a very small `--count`.

> Confirm the container name before you run this. `docker exec` against the wrong container is
> the easiest way to apply an RC plan to production or the reverse:
> `ssh veyora-vps "docker ps --format '{{.Names}}'"`

---

## 6. Creating missing accounts

**Off by default, and it should usually stay off.** A workbook row with no matching account
usually means the account was never imported, or the business name differs — both worth a human
look before inventing a record.

If the client confirms they want them created:

```bash
… node scripts/apply-credential-migration.mjs --dry-run --create-missing
… node scripts/apply-credential-migration.mjs --apply   --create-missing
```

New accounts get a database-generated id, role `customer`, status `active` and nothing else. No
existing order is touched or relinked. Rows whose only address is an import placeholder, or whose
business name appears twice in the workbook, are refused even with the flag.

---

## 7. Clean up, immediately

```bash
# nothing should exist to delete — but check, and delete anything that does
ls *.json payload* migration* 2>/dev/null
rm -f payload.json migration-payload.json          # if you ignored the advice above

# clear the shell history entry that names the workbook path
history -d $(history 1)                            # bash
Clear-History                                      # PowerShell
```

Also:

- remove any temporary copy of the workbook you made (a desktop copy, an email attachment you
  saved, an extracted CSV);
- keep the original in `D:\` where it started, or wherever the client keeps it;
- **do not** commit anything from this process. `git status` should be clean of payloads, dumps
  and spreadsheets before you commit anything else.

---

## If something goes wrong

| Symptom | What it means |
|---|---|
| `payload contains plaintext credential fields and was rejected` | something upstream added a plaintext field. Do not work around it — find out what added it. |
| `expected to update exactly 1 row, updated 0` | the account changed between the plan and the apply. Everything rolled back. Re-run the dry run. |
| `refusing to apply the same workbook twice` | this exact file was already applied. Only use `--force` if you intend to overwrite passwords customers may have changed. |
| `workbook headers must be exactly …` | the sheet was edited. Restore the five columns in order. |
| `duplicate email addresses in the workbook` | two rows claim one login. Resolve it in the sheet — the tool will not choose for you. |
| A customer still cannot sign in | check the dry-run report for their row: they were probably a `disabled`, `role` or `ambiguous` skip. |

To roll back entirely, restore the dump taken in §5. That reverts passwords **and** everything
else written since, so it is a first-hour option only.
