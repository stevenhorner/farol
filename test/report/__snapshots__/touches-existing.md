<!-- farol -->
### farol · merge risk 35/100 (medium) · ◐ quick review

Most of the risk comes from `Card.tsx`, used by 2 of 4 existing pages. 1 code file changed; 2 of 4 existing pages run changed code.

<sub>farol only informs: it never approves or blocks.</sub>

**Files by risk** (points are each part's share of the 35)
- 🔴 `src/components/Card.tsx` **35** · 2 of 4 pages

<details>
<summary>All signals</summary>

- **Why this review:** merge risk score 35/100; existing code changed: 2 existing page(s) run it; diff coverage not verified: risk is counted as if nothing were tested
- **Risk:** 1 high, 0 medium, 0 low
  - 🔴 `src/components/Card.tsx` 2/4 pages, 6 dependents
- **Vulnerabilities in added or changed dependencies:** not verified
- **Diff coverage:** not verified
- **Lint on changed lines:** not verified
- **Added suppressions:** none
- **Modified existing tests:** none

</details>

<details>
<summary>Classification — open only after reviewing</summary>

**Class:** `touches-existing` — touches existing code

**Reasons:**
- existing file modified (`existing-file-modified`) `src/components/Card.tsx`: func src/components/Card.tsx#Card changed: reached by 2 existing route(s): / &gt; (index); / &gt; products

**New routes:** none

**Affected existing routes:**
- `/` (`/ > (index)`) via `src/pages/HomePage.tsx` → `src/components/Card.tsx`
- `/products` (`/ > products`) via `src/pages/ProductsPage.tsx` → `src/components/Card.tsx`

**Was the classification right? Tick one option:**
- [ ] I agree with the classification
- [ ] I disagree: the PR changed existing behavior
- [ ] I disagree: the PR was isolated and farol missed it

</details>

<details>
<summary>Manual test checklist (2)</summary>

- [ ] `/` (via Card.tsx)
- [ ] `/products` (via Card.tsx)

</details>

<sub>farol &lt;version&gt; · analyzed commit 0123456789ab · shadow mode</sub>
