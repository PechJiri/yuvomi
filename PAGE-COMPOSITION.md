# Yuvomi Page Composition System

Spatial composition standard for Yuvomi application pages and third-party extension modules.

**Visual language** lives in [`DESIGN.md`](DESIGN.md) and [`public/styles/tokens.css`](public/styles/tokens.css).  
**Spatial composition** lives here, in layout primitives, and in [`public/utils/page-layout.js`](public/utils/page-layout.js).

```text
DESIGN SYSTEM
├── Visual language          → DESIGN.md + tokens.css
└── Page Composition System  → PAGE-COMPOSITION.md + layout primitives + audit
```

Budget core is **not** the reference implementation. It migrates as an offender alongside other modules.

---

## Part A — Composition Principles

### Principle Zero

> **A page is composed from a small set of spatial primitives. Individual modules may provide content and module-specific components, but must not define their own page geometry.**

A module owns: data, components, content, local interactions.

A module does **not** own: page width, horizontal alignment, global spacing, position vs shell, breakpoints, page header geometry, page grid.

```text
OK:   Module → Page → PageHeader + PageBody → module content
BAD:  Module → custom .page { width; padding; margin; breakpoint; absolute }
```

### Five spatial levels

```text
Application
└── ApplicationShell        # nav, chrome, viewport, overlays — NEVER module-owned
    └── Page                # composition mode, width token, gutters, header/body rhythm
        ├── PageHeader      # title, context, actions, nav — shares composition context with body
        └── PageBody
            └── Section     # semantic group; no page geometry
                └── Group
                    └── Component  # internal layout only
```

### Composition modes (exactly one per page)

| Mode | Purpose | Width token |
|------|---------|-------------|
| `reading` | notes, contacts, recipes, tasks list, forms | `--layout-reading` (~720px) |
| `data` | tables, inventory, documents list, large datasets | `--layout-content` (~960px) |
| `dashboard` | KPI grids, health, analytics | `--layout-wide` (~1200px) |
| `form` | complex forms inside reading column | `--layout-reading` |
| `split` | master/detail; stacks on mobile | split rails |
| `full` | calendar month, kanban, immersive | usable width |

Arbitrary values such as `max-width: 843px` are prohibited.

### Primary alignment edge

PageHeader, PageBody, and primary sections share one vertical axis. Components must not introduce a page-level axis.

### Full-bleed

Only via the explicit pattern `.page-section--bleed`. Negative margins for layout compensation are prohibited.

### Spacing rhythm

Component / Group / Section / Page — semantic distance equals spatial distance. Use layout tokens, not ad-hoc pixel values.

### Responsive behaviour

Responsive transformation is a property of the composition mode, not a module-local `@media (max-width: 637px)`.

### Components vs pages

**Components control internal layout; pages control external layout.**

### Extension declaration

Third-party modules declare intent; they do not implement geometry:

```json
{
  "page": {
    "composition": "reading",
    "width": "reading",
    "navigation": "standard",
    "responsive": "standard"
  }
}
```

### Blacklist

```text
❌ custom .page / page-container geometry
❌ arbitrary max-width / page margin / page padding
❌ negative margins to compensate for layout
❌ viewport-based positioning / absolute page-level layout
❌ module-owned breakpoints for page geometry
❌ changes to ApplicationShell
❌ custom page header outside approved primitives
❌ compensating for a core layout bug with local CSS
```

> **A module MUST NOT compensate for a core layout problem with local CSS.**

### Out of scope (v1 exceptions)

Documented exceptions — not forced through composition modes in v1:

- Shopping kitchen tabs shell
- Meals slot grid
- Settings SPA shell
- Auth chrome (login, setup, join, password reset)

---

## Part B — Implementation Contract

### Layout width tokens

Defined in [`public/styles/tokens.css`](public/styles/tokens.css):

| Token | Default | Role |
|-------|---------|------|
| `--layout-reading` | 720px | reading / form columns |
| `--layout-content` | 960px | data tables and wide lists |
| `--layout-wide` | 1200px | dashboard / KPI grids |

Legacy aliases remain for one release cycle:

- `--content-max-width-narrow` → `--layout-reading`
- `.page-measure--narrow` → reading mode compat class

### CSS primitives

Defined in [`public/styles/layout.css`](public/styles/layout.css):

| Class | Role |
|-------|------|
| `.app-page` | page root; no module geometry |
| `.app-page--reading\|data\|dashboard\|form\|split\|full` | composition mode; sets `--page-measure` |
| `.app-page__body` | page body slot (mode-owned gutters) |
| `.page-measure` | caps width to `--page-measure` (left-aligned) |
| `.page-section` | semantic section; no page geometry |
| `.page-section--bleed` | explicit full-bleed band |
| `.page-toolbar--measured` + `.page-toolbar__rail` | header slots grouped for the measure axis |

Mode modifiers set `--page-measure`:

- `reading`, `form` → `--layout-reading`
- `data` → `--layout-content`
- `dashboard` → `--layout-wide`
- `split`, `full` → none (mode rules apply)

### JavaScript helpers

[`public/utils/page-layout.js`](public/utils/page-layout.js):

| Export | Role |
|--------|------|
| `renderAppPage` | page root with mode + `data-composition` |
| `renderPageHeader` | canonical `.page-toolbar` (+ optional measured rail) |
| `renderPageTitle` | `.page-toolbar__title` |
| `renderPageActions` | `.page-toolbar__actions` |
| `renderPageBody` | `.app-page__body` |
| `renderPageSection` | `.page-section` (+ measure by default) |
| `renderListSection` | list section with measure cap |
| `renderMetricBand` | KPI band on the page measure |

Modules must not set page width, gutters, or breakpoints. They pass content into these helpers.

### Deprecations (1–2 releases)

| Legacy | Replacement |
|--------|-------------|
| `.page-measure--narrow` | `.app-page--reading` |
| `.budget-list-section` | `.page-section` |
| `.page-toolbar--narrow::after` as *sole* alignment story | `.page-toolbar--measured` + `__rail` (narrow may remain until Large-Title selectors accept the rail) |

New code must not introduce legacy aliases. Reference page already omits `.page-measure--narrow`.

### Audit invariants

Enforced in [`test/test-frontend-audit.js`](test/test-frontend-audit.js):

| ID | Invariant |
|----|-----------|
| PAGE-001 | Page has exactly one composition mode |
| PAGE-002 | PageHeader and PageBody share composition context |
| PAGE-003 | Primary content does not define arbitrary width |
| PAGE-004 | Page-level spacing uses layout tokens |
| PAGE-005 | Page does not define local breakpoints (allowlisted exceptions) |
| PAGE-006 | Page-level negative margins are prohibited |
| PAGE-007 | Helpers export the approved layout surface |
| PAGE-008 | Primary content edges align with declared grid |
| PAGE-009 | Responsive transformation follows composition mode |
| PAGE-010 | Full-bleed regions are explicitly declared (`--bleed`) |

**Strictness in this PR:** the **reference page** (`birthdays.js`) is audited end-to-end against helpers + no page geometry in module CSS. Other pages are **declaration-first** (mode on root); deep helper migration follows in stacked PRs.

### Reference / demo page

[`public/pages/birthdays.js`](public/pages/birthdays.js) is the **visual and structural gold standard** for this PR (`data-composition-reference="true"`).

Open **`/birthdays`** on a wide desktop (1440 / 1920) to demo the concept:

```text
.app-page--reading
├── .page-toolbar.page-toolbar--measured.page-toolbar--narrow
│   └── .page-toolbar__rail → title · search · actions   ← same --page-measure
└── .app-page__body
    ├── .page-section.page-measure          ← hint
    └── .page-section--list.page-measure    ← .row-carrier list
```

**Acceptance (reference):**

- [ ] Markup built only via `page-layout.js` helpers (no hand-rolled page width)
- [ ] `data-composition="reading"` and `data-composition-reference="true"`
- [ ] No `.page-measure--narrow` compat class on the root
- [ ] `birthdays.css` has no page-level `max-width` / page gutters / negative margins
- [ ] Header rail and list share one primary edge (±2px) at 1440 and 1920

### Visual regression (phase 2+)

Viewports **390 / 768 / 1024 / 1440 / 1920** — screenshot + width/alignment/overflow checks. Not a merge gate for this PR beyond the reference checklist above.

---

## FAQ — closed requirements

| Question | Answer |
|----------|--------|
| Is Budget the layout reference? | **No.** Budget is an offender; birthdays is the reference. |
| Must every page use `page-layout.js` in this PR? | **Reference must.** Others declare `data-composition` / `.app-page--*`; helper deep-migration is follow-up. |
| Why still `page-toolbar--narrow`? | Large-Title / wrap CSS still keys off direct toolbar children. Measured rail uses `display: contents` with narrow so the edge stays correct without rewriting every selector. |
| Why `--layout-*` and `--content-max-width-narrow`? | `--layout-*` is the contract; narrow is a one-cycle alias. |
| Can extensions invent width? | **No.** Declare `page.composition` and use helpers / `.app-page--*`. |
| What about shopping / meals / settings / auth? | Documented v1 exceptions — do not force composition modes yet. |
| How do I review this PR visually? | Open `/birthdays` at 1920px: one reading column, header actions flush with list edge. |

---

## Migration checklist

| Wave | Mode | Modules | Status in this PR |
|------|------|---------|-------------------|
| Reference | `reading` | **birthdays** | **Done (helpers + CSS)** |
| A | `reading` | contacts, notes, rewards, pantry, recipes | Mode declared |
| B | `data` | inventory, schedule, documents, housekeeping | Mode declared |
| C | budget family | budget + stats/plans/subscriptions/split | Mode declared; metric-grid on measure |
| D | `dashboard` / `full` | calendar, tasks, health, dashboard | Mode declared |

After v1, every layout question becomes: *which composition mode, and which contract clause is violated?*
