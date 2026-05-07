# Onboarding Flow

> 由 CLAUDE.md 移出於 2026-05-04


Guide the user through these 7 steps in order. Do not skip ahead.

### Step 1: Search Mode

Ask:
> "Are you looking to **rent**, **buy**, or **both**?"

- Set `search.mode` to `rent`, `buy`, or `both`
- Set `buyer_type`:
  - Renting → `renter`
  - Buying, no existing property → `first_time`
  - Buying, already own a home → `upgrader`

### Step 2: Region + Budget

Ask:
> "Which cities or districts are you targeting? And what's your budget?
> - For rent: monthly ceiling in TWD
> - For buy: total price ceiling in TWD, and your max monthly mortgage payment"

Fill in:
- `regions[].city` and `regions[].districts`
- `budget.rent_max` (if renting) or `budget.buy_max` + `budget.monthly_payment_max` (if buying)

### Step 3: Commute Origin

Ask:
> "Where do you commute to? (Work address, school, or major landmark — used to filter by commute time.) What's the maximum commute you'd accept in minutes?"

Fill in:
- `user.commute_origin`
- `user.commute_max_minutes`

### Step 4: Upgrader Supplement (only if `buyer_type = upgrader`)

Ask:
> "Since you're upgrading, I need a few details about your current property to help with timing and tax calculations:
> - Estimated current market value (TWD)
> - Outstanding mortgage balance (TWD)
> - Year you purchased it
> - Strategy: sell first, buy first, or simultaneous?"

Fill in `current_property` block:
- `estimated_value`, `loan_remaining`, `purchase_year`, `selling_strategy`

### Step 5: Create Config Files

Using the answers from Steps 1–4, auto-create the following:

- **`config/profile.yml`** — copy from `config/profile.example.yml`, fill in user's answers
- **`data/tracker.md`** — create with header:
  ```markdown
  # 物件追蹤

  | # | 日期 | 平台 | 地址 | 類型 | 價格 | 坪數 | 分數 | 狀態 | 報告 | 備註 |
  |---|------|------|------|------|------|------|------|------|------|------|
  ```
- **`data/scan-history.tsv`** — create empty file (header only):
  ```
  url	first_seen	last_seen	status
  ```
- **`data/pipeline.md`** — create with header:
  ```markdown
  # Pipeline Inbox

  Paste listing URLs here, one per line. Claude will process them in order.

  ## Pending
  ```

### Step 6: Copy Portals Config

Auto-copy `portals.example.yml` → `portals.yml`. Tell the user:
> "I've copied the default portals configuration. You can customize which sites and search parameters to use by editing `portals.yml`, or just ask me."

### Step 7: Ready

Confirm setup is complete and offer an immediate scan:
> "You're all set! Here's what you can do now:
> - Paste a listing URL to evaluate it
> - Say 'scan' to search your target regions for new listings
> - Say 'pipeline' to process any pending URLs
> - Say 'tracker' to see your search summary
>
> Want me to scan for listings in your target regions right now?"
