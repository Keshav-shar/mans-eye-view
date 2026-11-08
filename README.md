# Nexus

A local-first networking and skill tree, in the spirit of Obsidian. You paste raw notes about a company, an HR contact, a VC, a skill or an idea. A Groq model turns them into structured data. Nexus shows you exactly what would change, and only saves what you approve.

## Run it

```bash
npm install
cp .env.example .env        # then put your Groq key and model name in .env
npm start
```

Open http://localhost:3000. Requires Node 18 or newer.

`.env` needs two values. These names are read first; a few common alternatives (`GROQ_KEY`, `GROQ_MODEL_NAME`, `MODEL_NAME`) also work, so an existing file usually works as it is:

```
GROQ_API_KEY=...
GROQ_MODEL=...
```

## What you can do

- **Capture with AI.** Paste anything into the AI panel (Alt+A). Nexus shows a preview: new nodes, merges into existing ones, links, and every phone number, address, pro and con it found. Untick what you do not want, then add it to the tree.
- **Read a web page.** Under the note box in Capture, paste a URL and press Read page. Nexus fetches it safely, finds companies, people, investors, products and technologies, and shows the same preview before anything is saved.
- **Research the web.** The Research tab runs a session: search for a topic (needs `SEARCH_API_KEY`) or crawl one site you name. It reads the most valuable pages first (team, about, careers, funding news), files confident results as one undoable step, and puts everything it is unsure about in Review.
- **Ask your tree.** The Ask tab answers questions such as "who should I follow up with this week?" from your tree and, when relevant, from pages Nexus has read, with links to them.
- **Add anything by hand.** Every node has a type (company, person, hr, vc, skill, idea, path, or any word you invent), a brief, any number of named properties (phone, email, address, link, date), tags, pros, cons, notes in markdown, a follow-up date, a last-touched date, a 0 to 5 level, and links to other nodes with a named relationship.
- **Nest and link.** Drag rows in the sidebar to reorganise. Write `[[Name]]` in notes to link to a node; if it does not exist yet, clicking the link creates it.
- **See it three ways.** Note (the editor), Graph (solid lines are nesting, dashed lines are connections), and Follow-ups (overdue and upcoming follow-ups, people you have not touched in 30 days, skills you have not practised in 30 days).
- **Search everywhere.** Ctrl+K opens a palette that jumps to any node or runs a command.

Shortcuts: Ctrl/Cmd+K palette, Alt+A AI panel, Alt+G graph, Alt+N new node inside the open one, Alt+Shift+N new top-level node, Ctrl/Cmd+Z undo (outside text fields).

## How the AI step stays safe

The model never edits your tree directly. It returns JSON operations, and `lib/ops.js` is the only code that applies them.

- Only three operations are allowed: create, update, link. Delete, rename and move are refused, even if the model asks.
- Every id is checked against the real tree. Unknown ids, missing parents, self-links and cycles are rejected.
- Text is cleaned and length-limited. It is stored and shown as plain text, never as HTML.
- Duplicates merge instead of multiplying: "Razorpay Pvt Ltd" lands on the existing "Razorpay". Companies, VCs and skills match across the whole tree; people only match among siblings, and a same-name person elsewhere is flagged.
- Merging only adds. A different phone number is stored next to the old one, and a different brief is appended to notes as "Update: ...". Nothing you wrote is overwritten.
- You see a preview first. The final save re-checks everything against the current tree.
- Each save is atomic (write, flush, rename), validated before it lands, and keeps a snapshot, so Undo restores the previous state. A corrupt `tree.json` is set aside and the newest snapshot is restored.

## How web research works

A deterministic crawler surrounded by model tiers, all on your one Groq key:

| Tier | Default model | Job |
|---|---|---|
| Extractor ("Haiku") | `openai/gpt-oss-20b` | reads every kept page, up to 4 sections of it: entities of 11 kinds with their attributes, relations, page type, relevance, suggested searches, which links to follow |
| Planner ("Sonnet") | your `GROQ_MODEL` (`gpt-oss-120b`) | each round, picks the next searches from what pages said, and drops dead branches |
| Guard | `llama-prompt-guard-2-86m` | screens fetched text for prompt injection before any model sees it |
| Writer | the Fellegi-Sunter formula + Review queue (an LLM adjudicator is optional) | decides merges and writes through `lib/ops.js` |

Nexus asks Groq which models your key can use (`GET /models`) and falls back to `GROQ_MODEL` for any it cannot.

On Groq's free tier (8,000 tokens per minute per model), calls are paced to the limit instead of being dropped. The extractor reads up to 4 sections of about 4,500 characters per page (≈ 18,000 characters, roughly 2k tokens per call), so a 30-page session uses roughly 100–250k tokens and, paced to 8k tokens a minute, takes about 15–25 minutes (short pages need one call, long ones four). The AI budget defaults to 5 calls per page + 20 (at most 600), the token budget to 400k and the time budget to 25 minutes. On a paid tier, read whole pages with `{"extract":{"maxGroupsPerPage":8}}` in `data/config.json`.

If AI calls fail, the session log says why ("AI calls failing: extract_page: invalid-json ×3 (last: …)"), and the session summary carries `ai.failReasons` and `ai.lastError`.

To go back to rules with per-task AI fallbacks, set `{"strategies":{"extractor":{"use":"rules"},"query_planner":{"use":"templates"}}}` in `data/config.json`.

1. **Fetch** (`lib/web/`). The fetch step is Firecrawl-style: scrape, map and search.
   - **Network safety:** https only, no IP addresses or internal host names, every DNS answer checked and the connection pinned to it (no DNS rebinding), redirects re-checked hop by hop, 5 MB cap, text types only.
   - **Politeness:** robots.txt and Crawl-delay honoured, at most one request per second per site, an honest user agent.
   - **Blocks:** a 403, 429 or bot challenge pauses that site with an increasing cooldown and lists the page as Deferred for you to open. There is no CAPTCHA solving or evasion.
   - **Social networks:** these are on the deny list by default, because their terms forbid scraping.
   - **Search snippets:** when a result can't be read (deny list, robots.txt, JavaScript-only, blocked), its search-engine title and snippet are read instead. Anything found goes to Review, never straight into the tree.
   - **Entity homes:** when a page links an organisation to its own site ("[Two Sigma](https://www.twosigma.com/)"), that link becomes the organisation's Website and a strong identifier, and its homepage is queued. From the homepage, its team, about, portfolio, press and careers pages are read (6 pages and depth 2 per entity site, at most 15 entity sites per session; `domains.entityPerDomain`, `entityDepth`, `maxEntityDomains`). Links to other sites are followed from valuable pages or when the anchor names an entity on the page. Other open sites get 4 pages, depth 2. Every one of these requests passes the same URL, DNS, robots.txt, deny-list and rate-limit checks.
   - **Progress:** every search logs where its results went (queued, already queued, deny list, per-site limit). Every session records why it stopped.
   - **More formats:** PDFs (≤ 5 MB) are read as text. Transient errors are retried with backoff. Crawler traps are skipped. A page's `rel=canonical` is followed when it stays on the same site.
   - **JavaScript-only pages:** optionally rendered with Playwright. Set `NEXUS_BROWSER=on` and run `npm install playwright && npx playwright install chromium`. Every request the page makes passes the same URL and DNS checks, and images, fonts and media are never loaded.
2. **Parse** (`lib/parse/`).
   - **Rules first:** they collect the hard facts (JSON-LD, your own tree as a gazetteer, the research subject, lexicons, "Name, Title" lines, relation cues).
   - **Then the extractor model:** it reads the page in heading-labelled sections; on a long page, the intro plus the sections most relevant to the subject. Its output is checked against the page: names and attribute values must appear in it, every relation must quote a sentence that is really there, relation types come from a closed list, links can only be picked by number, and JSON-LD wins any conflict. An off-list page or entity type ("article", "hedge fund", "city") is mapped onto the closed lists instead of discarding the answer.
   - **What is extracted:** people, companies, investors, products, technologies, concepts, skills, **places**, **sectors**, **schools** and **events** (funding rounds, acquisitions, launches). Attributes become fields: Founded, HQ, Sector, Employees, Total funding, AUM, Stage, Status, Stage/Sector focus, Fund size, a person's Location (city), Education and Past roles, a product's Category, Launched and License, an event's Date, Amount and Round. Relations: works at, worked at, founded, invested in, acquired, builds, uses, competitor of, partner of, studied at, advises, board member of, subsidiary of, customer of, located in, operates in, invests in (a sector), took part in (an event), part of, related to, requires.
   - **People vs firms:** "Name, Title" lines only count when the title starts the line ("Asha Rao, CTO"), so a heading such as "Two Sigma" followed by "Two Sigma was founded … by computer scientist …" is not a person. A name that the page links to its own domain, that is followed by "was founded"/"manages $…"/"is a … firm", or that is also an organisation on the page or in your tree, is an organisation. Only the site's own team or about pages (by URL) make the people on them employees of the site; an article never makes everyone it mentions an employee of the publisher. A person's employer from the model needs a sentence that states employment.
   - **Founding sentences:** "X was founded in 2001 by computer scientist A and mathematician B" gives X a Founded year and A and B a *founded* link, even when X is "It" (the nearest heading names it).
   - **Fallback:** without a key, or once the budget is spent, the rules alone are used.
   - **Relevance:** embedding similarity to the subject, blended with the model's view and smoothed along each search branch. Below 0.35, nothing found on a page is followed. Near-duplicate pages are skipped.
3. **Build** (`lib/graph/`). Each entity is matched against your tree:
   - **Matching steps:** strong identifiers first (domain, GitHub, LinkedIn page), then hybrid retrieval (BM25 + embeddings + reciprocal rank fusion), then a Fellegi-Sunter matcher with vetoes.
   - **Saved automatically:** high-confidence matches, new entities, and links. Entities a page names without stating a relation are saved too (up to 25 per page, best first, when the model or the page's structure says they are real names) and linked *mentioned with* from the page's main entity (its site organisation, JSON-LD organisation, the organisation in its title, or the research subject), shown fainter. Turn this off with `{"extract":{"autoMentioned":false}}`.
   - **New groups:** Places, Education and Events are added once to your tree for these categories; sectors go under Concepts.
   - **Link status:** a link is *confirmed* once two independent sites (or one trusted site) say it; until then it's *single* and drawn fainter. Syndicated copies are detected with SimHash and count once.
   - **Learned trust:** each site's trust rises when its facts are corroborated and falls when you reject them in Review. Link confidence is weighted by it.
   - **Provenance:** every fact keeps where it came from (page, snippet, extractor and prompt version) in `data/web/nexus.db`, shown as "Evidence" on the node.
   - **Forget:** *Delete + forget web data* also removes the pages and snippets nothing else uses (this part can't be undone).
   - **Sent to Review:** ambiguous matches, weakly supported links and backlinker suggestions.
   - **People's contact details from the web** are never saved automatically.
   - **The single writer:** everything is applied through `lib/ops.js`, the same safety layer as Capture.
4. **Learn.** Your Review choices retrain the matcher and the page scorer.
   - **Evaluation:** `node eval/regression.js` compares the rules with the AI strategies on a small gold set.
   - **Live comparison:** add `--llm` to run the AI strategies on your key as well.
   - **Switching a strategy:** change one line in `data/config.json`, e.g. `{"strategies":{"adjudicator":{"use":"llm"}}}`.

On first start Nexus adds three groups (Products & Tech, Concepts, Research) and seeds Skills with ML Fundamentals, Vector Databases and Agentic Architecture, mirroring the techniques the research engine uses. Nothing existing is moved, and anything you delete is not added back.

## Where your data lives

`data/tree.json` is the whole tree, readable JSON. `data/history/` holds the last 60 snapshots. `data/web/` holds what research learned outside the tree: page sources and cleaned snapshots, site block state, the review queue, the merge log, vectors and the cached embedding model. Delete it to forget everything Nexus has read. Use the export and import buttons in the sidebar footer to back up or move it.

Your API key stays on the server. The browser never sees it. The server listens on 127.0.0.1 only, rejects other host names and cross-origin writes, and sends your notes to Groq only when you press Organise or Ask. Research sessions send short excerpts of fetched public pages to Groq within the budget you set, and search queries to your search provider. There is no login, so do not expose the port to a network.

## Project layout

```
server.js        routes and request guards
lib/schema.js    cleaning and validation of every value
lib/ops.js       turns model output into safe tree changes
lib/store.js     atomic saves, history, undo
lib/groq.js      prompts and the Groq client
lib/tree.js      queries and context selection for the model (BM25 + optional hybrid scores)
lib/llm/         Groq client, gateway (budgets, cache, rate limits), model router, prompt-injection guard
lib/web/         URL guard, safe fetch, robots, rate limits, block detection, scrape, PDF, optional renderer, map, search, evidence
lib/parse/       Haiku extractor (haiku.js), page classifier, entity tagger, relation extractor, outlink scoring
lib/graph/       graph builder (entity resolution, write policy), describer, verifier, backlinker
lib/ml/          BM25, TF-IDF hashing, logistic regression, Fellegi-Sunter + EM, SimHash, RRF, MMR, UCB1
lib/vector/      local embeddings and the flat vector index
lib/plan/        Sonnet query planner, templates, branches;  lib/session.js  research sessions;  lib/defaults.js  every tunable
lib/store/db.js  SQLite: fact provenance, query history, learned site trust
public/          the interface (plain ES modules, no build step)
eval/            gold pages and pairs, strategy regression harness
tests/           npm test
```
