<!-- farol -->
### farol · merge risk 30/100 (medium) · ◐ quick review

Most of the risk comes from `global.css`, a change that can affect the whole app. 1 code file changed; 0 of 4 existing pages run changed code.

<sub>farol only informs: it never approves or blocks.</sub>

**Files by risk** (points are each part's share of the 30)
- 🔴 `src/styles/global.css` **30**

<details>
<summary>All signals</summary>

- **Why this review:** a global file, manifest or critical dependency changed: everything may be affected; merge risk score 30/100; diff coverage not verified: risk is counted as if nothing were tested
- **Vulnerabilities in added or changed dependencies:** not verified
- **Diff coverage:** not verified
- **Lint on changed lines:** not verified
- **Added suppressions:** none
- **Modified existing tests:** none

</details>

<details>
<summary>Classification — open only after reviewing</summary>

**Class:** `global` — global change: configuration, critical dependency changes or files that affect the whole app

**Reasons:**
- global file changed (`global-file-changed`) `src/styles/global.css`: modified global file

**New routes:** none

**Affected existing routes:** none

**Was the classification right? Tick one option:**
- [ ] I agree with the classification
- [ ] I disagree: the PR changed existing behavior
- [ ] I disagree: the PR was isolated and farol missed it

</details>

<sub>farol &lt;version&gt; · analyzed commit 0123456789ab · shadow mode</sub>
