# Appendix 4 — Legal & Regulatory Risk Map

> **THIS IS NOT LEGAL ADVICE.** I am not a lawyer and this is not a legal opinion. This document is a
> research-based *risk map* for a personal, non-commercial project, assembled from publicly available
> SEBI circulars, regulations, FAQs, statutes and secondary commentary as of **6 August 2026**.
> Regulations change and enforcement is fact-specific. If this project ever takes money, opens to
> strangers, or gets incorporated, get an actual securities lawyer before you do.

**Scope of the thing being assessed:** a private group of friends in India. No fees of any kind.
One shared server reads each member's INDmoney portfolio over a **read-only MCP connection** (per-user
OAuth with a consent screen), notifies the group when a member trades, and — *only on that member's
explicit per-trade approval* — optionally mirrors a trade through **that person's own broker API
credentials, in that person's own account**.

---

## 0. Executive posture

Three findings drive everything below:

1. **The advice/RIA question is the one people worry about and is the *least* dangerous here.** SEBI's
   registration hook is *consideration*. No fees, no profit share, no closed-group monetisation, no
   public holding-out → you sit outside the IA and RA regulations on their face.
2. **The algo-trading question is the one nobody worries about and is the *most* dangerous here.**
   SEBI's Feb 2025 retail algo framework contains a carve-out that lets a retail investor use a
   self-built algo **for "family" only — explicitly "not for other investors"** — and defines family as
   self, spouse, dependent children, dependent parents. **Friends are not family.** A shared server
   placing API orders into other people's accounts is, on the plain reading, an *algo provider*, which
   must be empanelled with the exchanges and onboarded by the broker.
3. **The contract question is quietly binding.** INDmoney's T&C say the platform is for *"your personal
   use and purpose only"* and put all liability for anyone you give account access to on you. This isn't
   a SEBI penalty, but it is an account-termination and personal-liability exposure.

---

## 1. SEBI: is unpaid trade-sharing among friends "investment advice"?

### 1.1 What triggers Investment Adviser registration

SEBI (Investment Advisers) Regulations, 2013 — Reg. 2(1)(m) defines an investment adviser as
**"any person who, *for consideration*, provides advice to clients or other persons or group of persons
and includes any person who holds out himself as an investment adviser by whatever name called."**

SEBI's own FAQ restates the registration trigger:

> "Any person, who **for consideration**, is engaged or willing to engage in the **business** of providing
> investment advice to clients or other persons or group of persons is required to make an application
> to get registration under IA Regulations unless specifically exempted."
> — [SEBI FAQs on IA Regulations, Q4](https://www.sebi.gov.in/sebi_data/attachdocs/1424862077270.pdf)

And Reg. 3(1), per the same FAQ:

> "no person shall **act as an investment adviser or hold itself out as an investment adviser** unless he
> has obtained a certificate of registration from SEBI … unless an exemption specifically applies."

"Investment advice" itself is defined broadly — advice on buying/selling/dealing in securities or on an
investment portfolio, *"whether written, oral or through any other means of communication, for the
benefit of the client"* — but the **operative gate for registration is consideration plus doing it as a
business, or holding yourself out as an adviser.**

**Three cumulative elements you must keep absent:**

| Element | Our design |
|---|---|
| **Consideration** (fee, subscription, profit share, commission, referral kickback, ads, "server costs") | None, ever |
| **Business** (systematic, for clients, at scale) | Closed friend group, no clients |
| **Holding out** as an adviser | No public presence, no marketing, no "advisory" language |

There is **no explicit "friends and family" exemption** in Reg. 4 — the listed exemptions are for
insurance agents, pension advisers, MF distributors, brokers, PMs, advocates, CAs, CSs, cost accountants
etc. giving advice *incidental* to their main activity. So the defence is not an exemption; it is that
**you never satisfy the definition in the first place.** That's a strong position, but it is also a
brittle one: it collapses the moment any consideration appears.

- [SEBI (Investment Advisers) Regulations, 2013 (consolidated)](https://www.sebi.gov.in/sebi_data/meetingfiles/mar-2020/1583318232255_1.pdf)
- [SEBI FAQs on IA Regulations](https://www.sebi.gov.in/sebi_data/attachdocs/1424862077270.pdf)

### 1.2 Research Analyst Regulations, 2014

RA registration bites when a person prepares/publishes **research reports**, makes **buy/sell/hold
recommendations or price targets**, or makes **public recommendations** — particularly where reports are
*"circulated or distributed to public or general investors"*. Again the framing is a business activity
for consideration and/or public distribution.

A message saying "I bought 40 shares of X at ₹Y" to eleven named friends is not a research report and is
not public distribution. A weekly PDF with target prices, even free, sent to a growing list, starts to
look like one.

- [SEBI (Research Analysts) Regulations, 2014, last amended 16 Dec 2024](https://www.sebi.gov.in/legal/regulations/dec-2024/securities-and-exchange-board-of-india-research-analysts-regulations-2014-last-amended-on-december-16-2024-_90153.html)
- [SEBI FAQs on RA Regulations](https://www.sebi.gov.in/sebi_data/attachdocs/1418122025732.pdf)

### 1.3 The finfluencer crackdown (2023–2025) and where the line actually sits

SEBI has moved hard and repeatedly against unregistered persons giving trade calls:

- **Circular dated 22 October 2024** — *Association of persons regulated by the Board and their agents
  with certain persons*. Prohibits SEBI-regulated entities (brokers, exchanges, depositories, MFs, IAs,
  RAs, and **their agents**) from any **direct or indirect association** with any person who provides
  advice/recommendations on securities, or makes any express or implied **return/performance claim**,
  unless that person is SEBI-registered. Existing contracts had to be terminated within 3 months
  (by 22 Jan 2025). Carve-outs: **investor education** and association via a **"specified digital
  platform"** (a platform with preventive + curative mechanisms against prohibited activity), a
  recognition regime SEBI consulted on separately.
  [NSDL copy](https://nsdl.co.in/downloadables/pdf/2024-0160-Policy-SEBI_circular_regarding_Association_of_persons_regulated_by_the_Board_and_their_agents_with_certain_persons.pdf) ·
  [Clarifications circular (APMI)](https://www.apmiindia.org/storagebox/images/Circulars/DetailsClarifications%20on%20provisions%20related%20to%20Association%20of%20Persons.pdf) ·
  [FoxMandal note](https://foxmandal.in/News/registered-entities-to-cut-ties-with-unregistered-financial-advisors-sebi/) ·
  [FinSec Law note](https://www.finseclaw.com/article/sebi-directs-regulated-entities-to-terminate-contracts-with-unregulated-persons)
- **SEBI (Intermediaries) (Amendment) Regulations, 2024, s.16A** and January 2025 guidelines —
  closed the "it's only education" loophole: educators may use only market data with a **three-month
  lag**, and must be registered to give anything that amounts to advice.
  [Medianama](https://www.medianama.com/2025/02/223-sebi-regulated-entities-restriction-finfluencers/) ·
  [Legal500 update](https://www.legal500.com/developments/thought-leadership/securities-law-update-sebi-imposes-restrictions-on-intermediaries-and-finfluencers/)
- **Enforcement pattern:** PR Sundar (~₹6 cr settlement), "Baap of Chart" (~₹17.2 cr), and the
  **4 December 2025 order against Avadhut Sathe / Avadhut Sathe Trading Academy** — market ban plus
  impounding of **₹546 crore**, on a finding that "education" was in substance unregistered advisory and
  research. [Mondaq survey](https://www.mondaq.com/india/securities/1726258/sebis-crackdown-on-finfluencers-regulations-and-enforcement) ·
  [NLIU Law Review](https://nliulawreview.nliu.ac.in/blog/sebis-crackdown-on-finfluencers-a-legal-and-regulatory-perspective/)

**Read the enforcement pattern carefully: every single one of these involved money changing hands and a
public audience.** That is the shape SEBI prosecutes. Neither is present here.

**Important second-order effect of the Oct 2024 circular:** it binds *the broker*, not you. If the group
ever became publicly visible as a place where unregistered people post trade calls, INDmoney/INDstocks
would be *required* to disassociate — i.e. your risk shows up as **account termination and API cut-off**,
not as a SEBI penalty against you.

### 1.4 Copy trading specifically

- Copy/mirror trading is **neither banned nor a recognised regulated product** in India. There is no
  copy-trading regulation. It is permitted only insofar as it happens **through a SEBI-registered broker
  within the existing framework** (which, post-Aug 2025, means the algo framework in §2).
- SEBI has, however, treated mirror trading as a **PFUTP** matter where the facts were bad — notably
  mirror-trading-as-front-running allegations (e.g. the Aequitas Investment Consultancy complaint), and
  886 entities actioned under PFUTP Regs 2003 between Apr 2024 and Jun 2025.
  [RegStreet on the mirror-trading settlement](https://regstreetlaw.com/news/settlement-with-sebi-in-mirror-trading-case-sparks-a-debate/) ·
  [PFUTP enforcement volume](https://www.angelone.in/news/market-updates/sebi-targeted-886-entities-during-april-2024-june-2025-for-fraudulent-trading-practices)

**The PFUTP angle is a live, if low-probability, risk for *us* specifically:** a group where everyone
sees a member's buy *before or as* it executes creates a structural front-running hazard. If member A's
order is large and members B–L pile in ahead of or alongside it, that is exactly the fact pattern SEBI
reaches for. Design mitigation: **notify only on confirmed fills, never on intent**, and log timestamps.

### 1.5 Bonus risk nobody asks about: unregistered portfolio management

If the server were to execute in someone else's account **without that person's specific, contemporaneous
decision**, the arrangement starts to resemble **portfolio management**, which requires registration under
the SEBI (Portfolio Managers) Regulations (2020, succeeding 1993). SEBI has penalised individuals for
acting as unregistered portfolio managers.
[SEBI Portfolio Managers Regulations](https://www.sebi.gov.in/acts/act122.html) ·
[Enforcement example](https://www.business-standard.com/amp/article/pti-stories/fraudulent-trade-sebi-imposes-rs-15-lakh-on-individual-117101301280_1.html)

**The explicit per-trade approval is not a nicety. It is the single design feature that keeps the account
holder the decision-maker and keeps this out of PMS territory.** Never build a "trust mode" that
auto-executes without an affirmative, logged, per-trade human approval.

### 1.6 Where the line sits — sharing vs. advising

| Clearly fine | Grey | Clearly regulated |
|---|---|---|
| "I bought 40 ITC at ₹412 today." (past-tense fact about your own account, closed group) | "I'm planning to buy ITC tomorrow." (pre-trade intent → front-running surface) | "Buy ITC, target ₹480, stop ₹390." (recommendation + price target) |
| Sharing your own P&L with people who share theirs back | A recurring formatted digest with rationale, even free | Any of the above **for a fee, subscription, or profit share** |
| Group members independently deciding to do the same thing | Non-members asking to join | Open/public group, referral links, broker commissions |
| Automated notification of *your own* confirmed fills | An "approve" button that is one tap and habitually tapped | Marketing, performance claims, "X% returns" |

---

## 2. Algo trading — the sharpest edge in this project

### 2.1 The framework

**SEBI circular SEBI/HO/MIRSD/MIRSD-PoD/P/CIR/2025/0000013, 4 February 2025 — "Safer participation of
retail investors in Algorithmic trading."** Standards formulated by the Broker's Industry Standards Forum
by 1 April 2025; **provisions applicable from 1 August 2025**. Exchanges (NSE/BSE/MCX) issued
implementation standards in May 2025.
[SEBI circular PDF](https://www.cse-india.com/upload/upload/Feb_042025.pdf) ·
[SEBI timeline-extension circular, Sep 2025](https://www.sebi.gov.in/legal/circulars/sep-2025/extension-of-timeline-for-implementation-of-sebi-circular-dated-february-04-2025-on-safer-participation-of-retail-investors-in-algorithmic-trading-_96979.html) ·
[NSE circular INVG/67858](https://nsearchives.nseindia.com/content/circulars/INVG67858.pdf) ·
[FinSec Law on NSE standards](https://www.finseclaw.com/article/nse-releases-implementation-standards-for-retail-participation-in-algorithmic-trading)

Verbatim from the circular, the provisions that matter to us:

> **I(a)** "For the purpose of provision of algo trading through APIs, brokers shall be the **principal**
> while any algo provider or fintech/vendor … shall act as its **agent**, while using the API provided by
> the broker."

> **I(b)** "All algo orders originating/flowing through Application Programming Interface (API) extended
> by brokers to algo providers, shall be **tagged with a unique identifier** provided by Stock Exchange."

> **I(c)** "Algos developed by tech-savvy retail investors themselves, using programming knowledge, shall
> also be registered with the Exchange, through their broker, **only if they cross the specified order per
> second threshold**. Further, the same registered Algo shall be permitted to be used by such retail
> investors **for their family (but not for other investors)**. **'Family' for this purpose would mean
> self, spouse, dependent children and dependent parents.**"

> **I(d)** Brokers shall "not permit **open APIs** and allow access only through a **unique vendor client
> specific API key and static IP whitelisted by the broker** to ensure identification and traceability of
> the algo provider **and the end user**"; have "**OAuth** based authentication only"; "authenticate access
> to API through **two factor authentication**"; and "**deal with empaneled algo providers only**."

> **III(a)** "While algo providers shall not be regulated by SEBI, for better oversight, any algo provider,
> providing the facility to place algo orders with Brokers through API, shall **require to be empaneled with
> Exchanges** in a manner as stipulated by Exchanges."

> **V** Algos are categorised as **White box / Execution algos** (logic disclosed and replicable) and
> **Black box** algos (logic not known to the user, not replicable). For black box, "the algo provider
> shall **register as a Research Analyst**" and maintain a detailed research report per algo, re-registering
> the algo on any logic change.

**Order-per-second threshold:** the exchange implementation standards set **10 OPS** as the threshold for
unregistered API usage — below 10 OPS (measured on the broker's server clock) no algo registration is
required for a self-developed algo. Retail clients must supply a **static IP** to obtain API access, mapped
to their API key; API sessions must be logged out before each trading day.
[NSE standards summary — Business Standard](https://www.business-standard.com/markets/news/nse-issues-algo-trading-compliance-standards-retail-safety-125050501327_1.html) ·
[5paisa summary](https://www.5paisa.com/news/nse-issues-new-compliance-standards-for-retail-algo-trading-from-august-2025) ·
[ICICIdirect explainer](https://www.icicidirect.com/futures-and-options/articles/algorithmic-trading-new-rules-by-sebi-nse-retail-participation-with-safety-and-structure)

### 2.2 Does an approval-triggered mirror order count as an algo order?

**On volume: almost certainly not a problem.** A human tapping "approve" produces well under 10 OPS. The
OPS threshold is not your exposure.

**On architecture: this is the real exposure.** The threshold question is a red herring; the binding
constraints are the *family* limitation and the *algo provider* definition:

- I(c) permits a retail investor's self-built algo to be used **for family only, "but not for other
  investors."** A friend group is definitionally outside this. There is no "consent cures it" language.
- III(a) says **any** entity "providing the facility to place algo orders with Brokers through API" must be
  **empanelled with Exchanges**. A central server that accepts other people's credentials and places their
  orders is providing exactly that facility — the absence of a fee is not mentioned as relevant anywhere
  in the circular.
- I(d) requires **unique vendor-client-specific API keys** and a **broker-whitelisted static IP** per user,
  precisely so the broker can identify *both the algo provider and the end user*. A single server holding
  N users' tokens on one IP is the shape this clause was written to prevent.

**Two architectures, very different risk:**

| Architecture | Assessment |
|---|---|
| **A. Notify-only server + each member executes manually in their own app** | Cleanest. The server never places an order. No algo provider question arises at all. **Strongly recommended default.** |
| **B. Central server holds N members' API tokens and places their orders** | Looks like an unempanelled algo provider. Also breaches the broker's own API terms and the "personal use only" T&C. **Avoid.** |
| **C. Each member runs their own instance, own API key, own static IP, own machine; server only broadcasts signals** | Materially better than B — each person's automation is self-developed-and-self-used, below 10 OPS, own key, own IP. Still ask the broker. |

**Keep the logic white-box.** Our mirror rule ("when member A buys X, offer me the same trade at market")
is fully disclosed and replicable — an execution/white-box algo. If the logic ever becomes opaque to the
members (proprietary sizing, hidden filters), it slides toward **black box**, and the circular then wants
the algo provider **registered as a Research Analyst**. That would be a genuinely serious jump in exposure.

### 2.3 What the broker actually requires

From INDstocks' own API docs: access tokens are generated from the account dashboard, require completed
KYC, and **expire after 24 hours**; *"Your access token is like a password — keep it secure … Never share
it publicly or commit it to version control … Revoke immediately if compromised."* The dashboard exposes
**Static IP setup** and TOTP configuration. Orders carry an **`algo_id`** field, documented as
**99999 for regular (non-algo) orders** — i.e. the exchange unique-identifier tagging from I(b) is already
plumbed through, and mis-tagging algo orders as regular is a compliance issue in itself.
[INDstocks API — Getting Started](https://api-docs.indstocks.com/getting-started/) ·
[INDstocks API — FAQ](https://api-docs.indstocks.com/faq/) ·
[INDstocks API Trading](https://www.indstocks.com/features/api-trading)

**Action item:** before writing any order-placing code, email `api-support@indstocks.com` and ask, in
writing: *"Does an approval-triggered mirror order placed by software I wrote, running on my own machine
with my own API key and static IP, require algo registration or an `algo_id` other than 99999?"* Keep the
reply. A written broker answer is the cheapest risk mitigation available in this entire document.

---

## 3. INDmoney / INDstocks terms of service

### 3.1 INDmoney platform T&C

Quoted clauses from [indmoney.com/terms-of-services](https://www.indmoney.com/terms-of-services):

> "You shall be responsible to maintain **confidentiality of your INDmoney Platform account including your
> log-in credentials & OTPs**."

> "You shall continue to be **responsible for the transactions** in your INDmoney Platform account, if you
> knowingly or negligently (i) **grant any other person access to your account**, (ii) **permit any other
> person to transact on account**."

> "You understand and agree that You shall **only use the INDmoney Platform (including INDmoney Platform
> Services) for your personal use and purpose only**."

> Prohibition on "impersonat[ing] any person or entity, or falsely stating your age or affiliation with any
> person or entity."

> Indemnity: "You agree to indemnify Company or its directors, employees, associates, partners or suppliers
> for all the liabilities … arising due to (i) use or misuse of the INDmoney Platform (ii) non-performance …"

> "Company reserves the right in its sole discretion to delete, block, restrict, disable, suspend your
> account or part thereof. If User is found engaging in any fraudulent / illegal activities … these
> activities may be referred to appropriate legal authority."

**Reading:** "personal use and purpose only" is the clause that bites. Each member connecting *their own*
account for *their own* benefit is defensible as personal use. One member's server transacting in others'
accounts is not — and the access-grant clause makes each account holder personally liable for whatever
that server does, with no recourse against the operator. Termination is discretionary and needs no cause
beyond the company's judgement.

### 3.2 INDmoney MCP

From [indmoney.com/mcp](https://www.indmoney.com/mcp):

- **Read-only by construction:** *"INDmoney MCP cannot place trades, transfer money, redeem investments, or
  change any setting."* 14 tools, all retrieval.
- **OAuth 2.1 with PKCE**, sign-in on INDmoney's own page, an **explicit consent screen** listing requested
  data access, and *"Claude never sees your credentials."*
- **Short-lived, auto-rotated, server-side-encrypted tokens**; *"If exposed, it expires before it can be
  reused."* Instantly revocable from settings.
- **Purpose statement:** *"Your portfolio data is used **only to answer your questions in your Claude
  session**. We don't sell it."*

**Two implications.** (1) The read side of our design is the well-engineered part — per-user OAuth, per-user
consent, per-user revocation, no credential pooling, no write capability. Keep it that way. (2) That purpose
statement — *your* questions in *your* session — is narrower than what we do. We take member A's portfolio
data and **broadcast it to eleven other people.** That is arguably outside the stated purpose even though
A consented. Mitigation: obtain A's own explicit, written, in-group consent to redistribution; never
persist or republish beyond the group; and note that nothing found says one MCP client instance may serve
many users, so **do not assume it is permitted — treat multi-tenancy as an open question to ask INDmoney
about.**

---

## 4. Data privacy among friends (DPDP Act 2023)

### 4.1 The personal/domestic exemption

**Section 3(c)(i), DPDP Act 2023:** the Act shall not apply to *"personal data processed by an individual
for any personal or domestic purpose."*
[Bare text](https://www.dpdpa.com/dpdpa2023/chapter-1/section3.html) ·
[Section 3 commentary](https://www.apnilaw.com/bare-act/dpdp/section-3-digital-personal-data-protection-act-dpdp-application-of-act/)

**This exemption is narrow and it is genuinely uncertain whether we sit inside it.** It applies only to
**an individual** (not an organisation) and only to **genuinely personal or domestic** processing — the
canonical examples are a personal contact list, family photos, emailing friends. Arguments each way:

- *Inside:* one individual, a closed circle of personal friends, no commercial purpose, no monetisation,
  functionally a group chat with better tooling.
- *Outside:* it is a hosted server with accounts, persistent storage, audit logs, third-party OAuth
  integrations and retention — that is infrastructure, not a domestic activity. Any incorporation, any
  fee, or any growth beyond genuine personal friends almost certainly ends the argument.

### 4.2 Timeline

**DPDP Rules, 2025** notified by MeitY on **14 November 2025**. Phased: Data Protection Board operational
immediately; Consent Manager registration from ~Nov 2026; **full compliance by 13 May 2027** — itemised
notices, purpose-based retention, data-principal rights, reasonable security safeguards, **72-hour breach
notification**.
[MeitY/PIB notification](https://static.pib.gov.in/WriteReadData/specificdocs/documents/2025/nov/doc20251117695301.pdf) ·
[EY guide](https://www.ey.com/en_in/insights/cybersecurity/transforming-data-privacy-digital-personal-data-protection-rules-2025) ·
[Privacy World](https://www.privacyworld.blog/2025/11/india-passes-the-digital-personal-data-protection-rules-ushering-in-a-new-digital-age-in-india/)

### 4.3 Recommendation

**Build as if DPDP applies, even though it probably doesn't.** The cost is a page of text and a delete
button; the benefit is that you never have to litigate whether §3(c)(i) covers you, and the project can
grow without a privacy rewrite. Concretely:

- **Written, itemised, in-group consent** before anyone's data is read — stating exactly what is read
  (holdings? only trades? P&L absolute or percentage?), who sees it, how long it is kept.
- **Per-user opt-out and granular scopes.** Someone should be able to receive signals without broadcasting
  their own. Someone should be able to share *tickers and direction* without sharing *quantities or
  portfolio value* — position sizes reveal net worth, which is the most socially corrosive thing here.
- **Revocation = deletion.** Leaving the group deletes history, not just future access.
- **Minimise:** don't persist portfolio snapshots you don't need; prefer deltas and percentages over
  absolute rupee values; encrypt at rest; short retention.
- **No egress.** Never outside the group, never to any analytics/LLM/telemetry endpoint that isn't the
  ones members consented to, never sold or shared.
- **Breach plan:** tell the group within 72 hours, and mean it.

### 4.4 SEBI-side sensitivity of portfolio data

DPDP has no "sensitive personal data" tier, so financial data isn't specially classified — but SEBI-side
concerns are real and separate:

- **Front-running / PFUTP** (see §1.4): sharing pre-trade intent within a group is the dangerous pattern.
  Share **confirmed fills only**.
- **UPSI / insider trading:** if any member is a designated person, insider, or connected person at a
  listed company, that member's trade signals may carry or imply unpublished price-sensitive information,
  and mirroring them could pull the whole group into a PIT Regulations problem. **Ask everyone at
  onboarding whether they are an insider anywhere, and exclude those scrips.**
- **Trading window / employer policies:** many members will work at banks, brokers, funds or listed
  companies with pre-clearance obligations. Group visibility of trades is exactly what those policies
  police. That is each member's problem to solve, but onboarding should raise it explicitly.

---

## 5. Risk matrix

Likelihood is judged for the design as described (no fees, closed group, per-trade approval, own
credentials). "Impact" is the realistic worst case if it goes wrong.

| # | Activity | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|---|
| 1 | Central server places orders in others' accounts via their API tokens | **HIGH** — unempanelled algo provider under Feb 2025 circular III(a); outside the family carve-out I(c); breaches broker API terms and "personal use only" | Med (if built) | Broker termination; exchange/SEBI action against the operator | **Don't build it.** Notify-only, or each member runs their own instance with their own key + static IP |
| 2 | Sharing/pooling anyone's broker credentials or access tokens on shared infra | **HIGH** — direct T&C breach; account holder bears liability for every resulting trade | Low (avoidable) | Personal financial liability; account closure | Each person's credentials never leave their own device/instance. Server holds none |
| 3 | Charging *anything* — fee, subscription, profit share, "hosting costs", referral/broker commission | **HIGH** — converts to unregistered IA/RA activity under Reg. 3(1); this is the enforcement pattern (PR Sundar, Baap of Chart, Avadhut Sathe ₹546 cr) | Low (policy) | Ban from securities market; disgorgement; penalty | **Absolute bright line. Never, in any form, from anyone.** Operator absorbs infra cost personally |
| 4 | Group opens to strangers / public marketing / referral links | **HIGH** — "holding out"; public distribution triggers RA; and forces the broker to disassociate under the Oct 2024 circular | Low (policy) | Unregistered advisory finding; account cut-off | Invite-only, capped headcount, people you actually know, zero public surface |
| 5 | Making return or performance claims ("we're up 34% this year") | **HIGH** — express/implied performance claim is independently prohibited conduct under the Oct 2024 circular | Med (easy to slip into) | Same as #4 | Ban performance claims in-group and out. No leaderboards, no "returns" framing |
| 6 | Broadcasting **pre-trade intent** rather than confirmed fills | **MED** — front-running / PFUTP surface; the mirror-trading cases SEBI pursued were front-running cases | Med | PFUTP investigation | Notify **only on confirmed fills**, with server-side timestamps in the audit log |
| 7 | Auto-execution without per-trade approval ("trust mode") | **MED-HIGH** — starts to look like unregistered portfolio management | Low (design) | PMS violation; penalty | Per-trade explicit approval, always, logged. No standing authority, no "approve all" |
| 8 | Black-box logic (opaque sizing/filters members can't inspect) | **MED** — Feb 2025 circular §V requires the algo provider to **register as a Research Analyst** | Low | RA registration obligation | Keep logic white-box, documented, replicable, readable by every member |
| 9 | Redistributing member A's portfolio data beyond INDmoney's stated MCP purpose | **MED** — outside "only to answer your questions in your Claude session"; possible ToS friction | Med | Access revoked; trust damage | Explicit written in-group consent to redistribution; ask INDmoney about multi-user use |
| 10 | DPDP applicability if §3(c)(i) doesn't cover us | **LOW-MED** — narrow exemption, and a hosted multi-user server is arguably not "domestic" | Low | Data Protection Board complaint; penalties | Build DPDP-compliant anyway (§4.3). Cheap insurance |
| 11 | Insider/UPSI contamination via a member who is a designated person | **MED** — PIT Regulations exposure for the whole group, not just that member | Low | Insider trading proceedings | Onboarding declaration; per-member scrip exclusion list; respect trading windows |
| 12 | Mis-tagging algo orders (using `algo_id` 99999 for automated orders) | **MED** — defeats the I(b) audit trail the framework exists to create | Med | Broker/exchange compliance action | Confirm correct tagging with the broker **in writing** before automating anything |
| 13 | Exceeding 10 OPS | **LOW** — human-approved orders are orders of magnitude below | Very low | Algo registration requirement | Rate-limit the order path defensively anyway |
| 14 | Social/relational fallout — someone loses money mirroring a friend | **HIGH in practice, non-regulatory** | Med-High | Ruined friendships; potential civil claim | Risk disclosure at onboarding, position-size caps, no pressure to mirror, "your account, your call" framing everywhere |

---

## 6. Practical guardrails checklist

**Non-negotiable (any one of these breaks the safe-side argument):**

- [ ] **No consideration, ever.** No fees, subscriptions, profit shares, tips, gifts, "server cost splits",
      broker referral commissions, affiliate links, or ads. The operator eats the hosting bill.
- [ ] **Closed and small.** Invite-only, capped, people you genuinely know. No public page, no landing
      site, no app store listing, no social posts, no name that sounds like a product.
- [ ] **Explicit per-trade approval, always.** No standing authorisation, no "auto mode", no "approve all",
      no default-yes timeouts. One human decision per order, logged.
- [ ] **Each person's own credentials, own account, own device.** The shared server never holds another
      person's broker token. If mirroring is automated, each member runs their own instance with their own
      API key and their own broker-whitelisted static IP.
- [ ] **No performance or return claims.** In-group or out. No leaderboards.
- [ ] **Confirmed fills only.** Never broadcast pre-trade intent.

**Strongly recommended:**

- [ ] **Written onboarding pack** every member signs: risk disclosure (you can lose money; nobody here is an
      adviser; nobody is responsible for your P&L), consent to data sharing with itemised scope, insider
      declaration, and an explicit "this is not advice" acknowledgement.
- [ ] **Standing disclaimer** on every notification: *"Information about another member's own trade. Not
      advice. Not a recommendation. Your account, your decision."*
- [ ] **Audit log**, append-only: who traded what and when, what was broadcast, who approved what at what
      timestamp, who consented to what and when, who opted out. This is your evidence that approvals were
      real and that no one was acting for anyone else.
- [ ] **Granular privacy scopes:** share direction and ticker without quantities; opt out of broadcasting
      while still receiving; leave-the-group deletes history.
- [ ] **Written broker confirmation** (§2.3) before any order-placing code ships. Keep the email.
- [ ] **White-box logic**, readable by every member.
- [ ] **Position-size caps** and a defensive rate limit on the order path.
- [ ] **Kill switch** — one command halts all automated order placement, for everyone.
- [ ] **Annual re-consent** and a review of whether any of the bright lines have drifted.

**Tripwires — if any of these become true, stop and get a lawyer:**

money changes hands in any direction · membership exceeds people you'd invite to dinner · anyone asks to
join who you don't personally know · you incorporate or register a domain that markets it · someone asks
for a "managed" or "auto" mode · you start publishing results · a member becomes a designated person at a
listed company · a broker or exchange asks you a question about it.

---

## 7. Unknowns

Things I could **not** resolve from public sources. These are genuine gaps, not hedging:

1. **Does SEBI's "algo provider" concept reach a non-commercial, unpaid, single-purpose script?** The Feb
   2025 circular says nothing about consideration in III(a). The plain text captures anyone "providing the
   facility to place algo orders with Brokers through API." Whether SEBI or the exchanges would apply that
   to a hobbyist serving eleven friends for free is **untested and unanswered**. I found no informal
   guidance, FAQ, or enforcement on this point. **This is the single biggest unknown in the project.**
2. **Exact exchange empanelment criteria for algo providers**, and whether any de-minimis or non-commercial
   exception exists. NSE/BSE SOPs are referenced by the circular but I did not retrieve the criteria text.
3. **Whether "family" in I(c) has been read more broadly anywhere.** The definition is closed on its face
   (self, spouse, dependent children, dependent parents) and I found no clarification extending it.
4. **INDmoney's position on multi-user MCP usage.** Nothing on their MCP page addresses one client instance
   serving several users. Not prohibited, not permitted — unaddressed. Needs a direct question to them.
5. **Full INDstocks API terms of use.** I read the public developer docs (getting-started, FAQ) but not a
   standalone API licence agreement; one may exist behind the dashboard and may contain vendor/redistribution
   clauses that change §2.2's conclusion.
6. **Whether `algo_id` 99999 is correct for approval-triggered orders.** The docs describe it as the value
   for "regular orders" but don't define the boundary. Broker confirmation required.
7. **Precise text of the 22 Oct 2024 circular's "association" definition.** I have the substance from
   multiple reliable secondary sources and the SEBI/NSDL circular summary, but the primary PDF fetch failed
   (connection reset). Worth reading the original before relying on the carve-outs.
8. **Whether §3(c)(i) DPDP covers a hosted multi-user server run by one individual for friends.** No
   guidance, no Board decisions yet — the Board only became operational in Nov 2025. Genuinely open.
9. **Any SEBI enforcement specifically against a *free*, *closed* copy-trading arrangement.** I found none.
   Every case I located involved fees and a public audience. Absence of enforcement is weak evidence of
   legality, but it is the honest state of the record.
10. **Civil liability between members** if someone loses money — not researched at all here. Contract/tort
    exposure between friends is a separate question from securities regulation.

---

*Compiled 6 August 2026. Sources are linked inline throughout. Again: this is research, not legal advice.*
