# AI Agent Travel Payment: Deep Research

Research date: 2026-04-06

---

## Part 1: How Human Travel Agents Handle Payment

### The Three BSP Payment Models

When a human travel agent books a flight, payment flows through IATA's Billing and Settlement Plan (BSP) — a clearing system spanning 207+ countries, 59,000+ travel brands, and 400+ airlines, processing $240B+ annually.

There are **three distinct payment models**:

**1. Cash Flow (Agent as Merchant of Record)**
- Agent charges the client's credit card directly (agent processes the payment)
- Agent issues ticket through GDS (Amadeus, Sabre, Travelport)
- GDS reports sale to IATA's Data Processing Center
- Agent receives consolidated weekly billing report
- Agent remits a single payment to IATA clearing bank covering all airline sales
- Clearing bank distributes to airlines 2-4 weeks later
- **The agent IS the merchant of record.** Client sees the agency on their card statement.

**2. Customer Card Flow (Airline as Merchant of Record)**
- Agent forwards client's card details to the GDS
- GDS validates card with issuing bank
- Airline withdraws funds directly from the customer's card
- **The airline IS the merchant of record.** Agent never processes the payment.
- Settlement occurs through normal card network rails (days, not weeks)

**3. IATA EasyPay (Prepaid Wallet)**
- Agent preloads a digital wallet
- Shares EasyPay number with GDS
- GDS authorizes from wallet balance
- Airlines receive funds in 2-4 days

### Key Insight: Agents DO See Card Numbers

In models 1 and 2, the agent either charges the card directly or passes card details through the GDS. **Traditional travel agents routinely handle client payment information.** This is why trust and IATA accreditation matter.

### Corporate Travel: Lodge Cards and Virtual Cards

TMCs (Travel Management Companies like Amex GBT, BCD, CWT) use a different pattern:

- **Lodge Card**: A single virtual card number attached to the *company* (not an individual). Stored ("lodged") in the TMC's booking system. All travel bookings charge to this one card. Company settles monthly.
- **Virtual Cards per Booking**: TMC generates a unique virtual card for each booking, with exact spend limit matching the fare. Card auto-closes after use.
- Over 98% of airlines accept virtual card payments (Amadeus data).
- Credit terms: 40-60 days (AirPlus, Amex, Diners).

### Trust Accounts

In regulated states (CA, FL, HI, WA, IA, NV), travel agents must maintain trust accounts for client funds — money held in escrow, never commingled with operating funds. Penalties up to $10K/violation for non-compliance.

---

## Part 2: Virtual Cards for AI Agents — The 2026 Landscape

The virtual card issuing space has **exploded** in 2025-2026, specifically targeting AI agent use cases. Here's every viable platform:

### Privacy.com — Best for Individual Agent Use

| Feature | Detail |
|---|---|
| **Model** | Consumer virtual card issuer, now with AI agent focus |
| **API** | REST API + MCP server (`claude mcp add --transport http privacy-mcp https://mcp.privacy.com`) |
| **Card types** | SINGLE_USE (auto-closes after one txn), MERCHANT_LOCKED, CATEGORY_LOCKED |
| **Spend controls** | Per-card limit, per-transaction limit, merchant lock, category lock, pause/close |
| **Free tier** | 12 cards/month free (no API access). API requires Plus ($5/mo, 24 cards) or Pro ($10/mo, 36 cards) |
| **Network** | Mastercard/Visa via Patriot Bank N.A. |
| **Security** | PCI-DSS, SOC 2 Type II, 256-bit encryption |
| **Best for** | Easiest path for an individual giving their agent a spending card |

**Privacy.com CLI for agents:**
```
privacy cards create --type SINGLE_USE --spend-limit 500
privacy cards list
privacy cards pause <token>
privacy cards close <token>
privacy transactions list --card-token <token>
```

### Stripe Issuing — Best for Platform/Product Integration

| Feature | Detail |
|---|---|
| **Model** | Developer-first card issuing platform |
| **API** | Full REST API + Agent Toolkit + MCP server |
| **Card creation** | Create cardholder, then issue virtual card (`type=virtual`, `status=active`) |
| **Spend controls** | Spending limits, merchant category restrictions, per-authorization rules |
| **Pricing** | $0.10 per virtual card, 0.2-0.3% per domestic txn, no monthly fee |
| **Single-use** | Yes, via Shared Payment Tokens (SPTs) — scoped to business, time-limited, amount-capped, revocable |
| **Agent Toolkit** | Spin up scoped, single-use virtual card for specific purchase |
| **Best for** | Building an agent payment product; tightest integration with Stripe ecosystem |

### Lithic — Best for Custom Programs

| Feature | Detail |
|---|---|
| **Model** | Infrastructure-level card issuing for developers |
| **API** | REST API, full sandbox, all endpoints available in test mode |
| **Card types** | Virtual and physical, with per-card and per-account spend limits |
| **Spend controls** | Auth Rules — restrict by merchant category, txn amount, velocity, time of day |
| **Pricing** | Per-card fee (specifics not public), no expensive monthly fees |
| **Best for** | Custom card programs with complex authorization logic |
| **Note** | Lithic is the B2B arm of Privacy.com (same company, rebranded 2021) |

### Slash — Best MCP-Native Integration

| Feature | Detail |
|---|---|
| **Model** | AI-native neobank with MCP-first design |
| **API** | Full API + native MCP server (Claude, GPT, Cursor compatible) |
| **Card creation** | Unlimited virtual/physical cards via single API call |
| **Spend controls** | Per-card limits, card groups, velocity controls |
| **Security** | RSA-OAEP encryption — agents never see raw card numbers. Human-in-the-loop approval for write ops |
| **Best for** | Agent that needs full banking (cards + ACH + invoices + balance) |

### Marqeta — Best for Enterprise Scale

| Feature | Detail |
|---|---|
| **Model** | Enterprise card issuing platform with MCP server |
| **API** | Full REST API + MCP server for agent workflows |
| **Card creation** | Instant virtual cards, spend/velocity controls, dispute management |
| **Best for** | Large-scale programs, enterprise compliance requirements |

### Crossmint — Best for Multi-Rail (Fiat + Crypto)

| Feature | Detail |
|---|---|
| **Model** | All-in-one: wallets, virtual Visa/Mastercard, stablecoins |
| **API** | Single API surface for cards + crypto + stablecoins |
| **Spend controls** | Spending limits, merchant access, transaction caps, dual-key architecture |
| **Best for** | Agents that need both fiat and crypto payment rails |

### CardForAgent — Purpose-Built for Agents

| Feature | Detail |
|---|---|
| **Model** | Virtual card API built on Stripe Issuing, specifically for AI agents |
| **API** | 5 built-in MCP tools for autonomous agent payments |
| **Best for** | Drop-in agent payment if you don't want to build on Stripe directly |

---

## Part 3: Network-Level Agent Payment Infrastructure

The card networks themselves are building agent-specific payment rails:

### Visa Intelligent Commerce (VIC)

- Launched 2025, live production transactions Dec 2025
- **Tokenized credentials**: AI-ready tokens bound to specific agent, usable only in that agent's context
- **Trusted Agent Protocol (TAP)**: Open framework to distinguish legitimate AI agents from bots
- **Spend controls**: Dollar limits, merchant category restrictions, real-time approval prompts
- **Developer APIs**: VisaNet APIs for identity checks, spending controls, tokenized credentials
- **Status**: 100+ partners building on VIC. Pilots in APAC/Europe early 2026.
- **How to access**: Through issuing partners (banks), not direct Visa integration

### Mastercard Agent Pay

- **Agentic Tokens**: Dynamic digital credentials issued through partner banks (Citi, US Bank, Santander)
- **Know Your Agent (KYA)**: KYC-like process for agents — must be registered to receive tokens
- **Intent-carrying tokens**: When agent buys "Adidas shoes, size 10, €80", that intent data travels WITH the token through the network
- **Status**: Citi/US Bank enabled 2025. All US Mastercard cardholders by Nov 2025. Europe first live txn (Santander) early 2026.
- **How to access**: Through bank partners implementing the Agent Pay Acceptance Framework

### Stripe Shared Payment Tokens (SPTs)

- Customer provides payment method to agent
- Agent issues scoped SPT through Stripe (specific seller, amount, time limit)
- Agent sends SPT to seller
- Seller creates PaymentIntent with SPT to complete payment
- **Expanding to**: Mastercard Agent Pay, Visa Intelligent Commerce, BNPL (Affirm, Klarna)

### Stripe Machine Payments Protocol (MPP)

- Launched March 2026 (co-authored with Tempo)
- Session-based streaming payments
- Stripe compliance stack built in
- Designed for autonomous machine-to-machine commerce

---

## Part 4: The "Agent Does Everything, Human Just Pays" Pattern

This is the critical design question: can the agent handle search/selection/hold while the human only handles payment?

### Pattern A: Duffel Hold + Duffel Links

**How it works:**
1. Agent searches flights via Duffel API
2. Agent finds best option, presents to human for approval
3. Agent creates a **hold order** (if airline supports it — check `payment_requirements.requires_instant_payment === false`)
4. Hold reserves the seat without payment. Deadline in `payment_required_by` field.
5. Agent creates a **Duffel Links session** (`POST /links/sessions`) — a branded checkout URL
6. Agent sends link to human
7. Human clicks link, completes payment through Duffel's hosted checkout
8. Duffel pays the airline. Human's card is charged by Duffel.
9. Agent receives `order.created` webhook with booking confirmation

**Limitation**: Duffel Links currently creates a *search-and-book* experience — the documentation does not confirm you can pre-populate a specific held order into the link. The link starts the user at search. This means the human may need to re-search, which defeats the purpose.

**Workaround**: Use Duffel's embeddable Card Payment Component (`@duffel/components`) on a simple web page you control, pre-loaded with the held order's PaymentIntent. The human visits your page and just enters their card. But this requires hosting a web page.

### Pattern B: Agent Creates Virtual Card, Pays Directly

**How it works:**
1. Agent searches flights via Duffel API
2. Agent finds best option, presents to human for approval
3. Human approves (via chat)
4. Agent creates a SINGLE_USE virtual card (Privacy.com, Stripe Issuing, etc.) with spend limit = exact fare amount
5. Agent uses virtual card to pay for the hold order via Duffel API
6. Card auto-closes after the single transaction
7. Agent reports booking confirmation to human

**Funding source**: The human pre-funds the virtual card source (linked bank account on Privacy.com, Stripe Issuing balance, etc.). The agent never has access to the funding source — only to ephemeral, scoped, single-use card numbers.

**This is the TMC lodge card pattern applied to AI agents.** It's exactly how corporate travel has worked for decades.

### Pattern C: Payment Link (Non-Duffel)

If not using Duffel, many payment processors (Stripe, Checkout.com) support creating **payment links** — standalone URLs where a customer completes payment:
1. Agent does all research, finds best option
2. Agent creates a Stripe PaymentIntent + Payment Link with the exact amount
3. Agent sends link to human
4. Human pays via hosted checkout page
5. Agent receives webhook confirmation, then completes the booking

This requires the agent/platform to be a payment processor (Stripe merchant account), which adds PCI complexity.

### Pattern D: Airline 24-Hour Hold + Manual Booking

**Simplest but least automated:**
1. Agent searches and finds best flight
2. Agent creates a hold (DOT requires 24-hour hold for US carriers)
3. Agent sends human the PNR/confirmation code and airline booking link
4. Human goes to airline website, pulls up the held booking, and pays
5. Agent monitors for confirmation (or human reports back)

Airlines supporting free holds: American (24hr, 7+ days before departure), Emirates (72hr "Hold My Fare"), Copa (48hr), SWISS (72hr for a small fee).

---

## Part 5: The Complete User Story — What's Possible Today

### The Simplest Path (Available Right Now)

**Stack: Duffel API + Privacy.com (or Stripe Issuing)**

```
Human: "Find me a flight SFO to Tokyo, July 15-22, economy"

Agent:
  1. duffel_search_flights(SFO, TYO, 2026-07-15, economy)
  2. Presents top 3 options with prices, times, airlines
  
Human: "Book option 2 — ANA direct, $890"

Agent:
  3. Creates hold order on Duffel (if airline supports hold)
     OR proceeds directly to payment
  4. Creates SINGLE_USE Privacy card: spend_limit=$890
  5. Pays via Duffel API using virtual card
  6. Card auto-closes
  7. Returns confirmation number, e-ticket, itinerary
```

### What Makes This Work

**The human never shares their credit card with the agent.** Instead:
- Human links their bank account to Privacy.com (one-time setup)
- Agent creates scoped, single-use cards through Privacy.com API/MCP
- Each card has an exact spend limit (e.g., $890 for this specific flight)
- Card auto-closes after one transaction
- Human sees every transaction in Privacy.com dashboard
- Human can pause or revoke any card at any time

**This is functionally identical to how a corporate traveler's TMC works** — the TMC has a lodge card funded by the company. The TMC books travel and charges the lodge card. The company sees all charges and controls the funding.

### What's Missing / Gaps

**1. Duffel + Virtual Card Integration**
- Duffel Payments expects customer card details collected via their frontend component, OR balance payment from your Duffel account
- Using a virtual card as the payment method requires Duffel's "pay with customer card" flow, which expects card details (number, CVV, expiry) passed through their component
- **Gap**: Can the agent programmatically pass a Privacy.com virtual card through Duffel's API without a browser frontend? Duffel's card payment flow is designed for browser-based collection. The agent would need to use the backend API directly with card details.

**2. Duffel Balance vs. Card Payment**
- Simpler alternative: Pre-fund your Duffel Balance account, let the agent pay from balance
- Agent creates order with `type: "balance"` payment
- No card needed at all — you top up your Duffel account like a prepaid wallet
- **This is actually the simplest path** if you're willing to pre-fund

**3. Duffel Links Doesn't Support Pre-Populated Holds**
- Links create a search experience, not a "complete this specific booking" experience
- The human would need to re-search and re-find the flight
- Not viable for the "agent does everything, human just pays" pattern

**4. Hold Order Availability**
- Not all airlines support hold orders on Duffel
- Check `payment_requirements.requires_instant_payment` on each offer
- Many budget carriers require instant payment

### Recommended Architecture for Ouroboros

**Phase 1: Balance-Based (Simplest, works today)**
```
Setup: Human pre-funds Duffel Balance ($500, $1000, etc.)
Flow:  Agent searches → human approves → agent pays from balance → done
Pros:  No card handling, no PCI concerns, fully API-driven
Cons:  Requires pre-funding, money sits in Duffel account
```

**Phase 2: Privacy.com Virtual Cards (More flexible)**
```
Setup: Human links bank to Privacy.com, gives agent MCP access
Flow:  Agent searches → human approves → agent creates SINGLE_USE card →
       agent pays Duffel with card → card auto-closes → done
Pros:  Per-booking spend control, no pre-funding pool, human sees every charge
Cons:  Need to solve card-detail passing to Duffel API (PCI consideration)
```

**Phase 3: Network-Level Agent Tokens (Future)**
```
Setup: Human's bank issues Mastercard Agent Pay / Visa VIC token to agent
Flow:  Agent searches → human approves → agent pays with scoped token →
       full network-level fraud protection + intent verification → done
Pros:  Bank-grade security, network-level controls, no virtual card plumbing
Cons:  Not widely available yet (rolling out through 2026)
```

### Cost Analysis

| Component | Cost |
|---|---|
| Duffel flight search | Free (1500 searches per booking) |
| Duffel booking | $3.00 per confirmed order |
| Duffel managed content | 1% of order value |
| Privacy.com (Pro) | $10/month for 36 cards + API access |
| Stripe Issuing (alt) | $0.10/card + 0.2% per txn |
| Duffel FX fee | 2% if currency conversion needed |

**Total cost for a $500 domestic flight: ~$8-10** (Duffel order fee + markup)
**Total cost for a $1500 international flight: ~$18-25** (order fee + 1% managed content + FX)

---

## Summary of Key Findings

1. **Human travel agents DO handle client card details** — this is normal in the industry. The BSP system consolidates settlement. Trust accounts protect client funds.

2. **Virtual cards are the proven pattern for delegated spending** — TMCs have used lodge cards and virtual cards for decades. The AI agent version is a direct analog.

3. **Privacy.com is the lowest-friction option for a personal AI travel agent** — MCP server ready, SINGLE_USE cards, $5-10/month, immediate API access.

4. **Duffel Balance is the simplest payment method** if you don't mind pre-funding — no card handling at all.

5. **Duffel Links can't pre-populate a held booking** — the "agent books, human pays via link" pattern doesn't fully work with Duffel today. You'd need a custom checkout page.

6. **Network-level agent tokens (Visa VIC, Mastercard Agent Pay) are coming** but not yet broadly available. By late 2026, most US cardholders should have access.

7. **The $3T agentic commerce wave is real** — every major payment network, every major bank, and dozens of startups are building agent payment infrastructure right now.

---

## Sources

### Part 1: Human Travel Agent Payment
- [BSP: IATA's Billing and Settlement Plan Explained](https://www.altexsoft.com/blog/iata-bsp/)
- [IATA BSP Official](https://www.iata.org/en/services/finance/bsp/)
- [How Travel Agents Get Paid](https://www.foratravel.com/join/resources/how-do-travel-agents-get-paid)
- [TMC Virtual Credit Cards](https://www.getpliant.com/en/blog/tmcs-and-virtual-credit-cards/)
- [Lodge Card Explained](https://www.natwest.com/business/cards/virtual-card-solution/lodge-card.html)
- [Travel Agent Trust Accounts](https://antravia.com/trust-accounting-in-practice-how-travel-advisors-can-protect-client-funds)
- [ARC Payment Best Practices](https://www2.arccorp.com/support-training/travel-agency-payment-best-practices/)
- [TMCs and Virtual Credit Cards](https://www.getpliant.com/en/blog/tmcs-and-virtual-credit-cards/)

### Part 2: Virtual Card APIs
- [Privacy.com AI Agent Control](https://agents.privacy.com)
- [Privacy.com Pricing](https://www.privacy.com/pricing)
- [Privacy.com Developer API](https://developers.privacy.com/docs/getting-started)
- [Stripe Issuing Virtual Cards](https://docs.stripe.com/issuing/cards/virtual/issue-cards)
- [Stripe Issuing Pricing](https://stripe.com/pricing)
- [Lithic Developer Docs](https://docs.lithic.com/docs/welcome)
- [Lithic Agentic Payments](https://www.lithic.com/blog/agentic-payments)
- [Slash for Agents](https://www.slash.com/platform/agents)
- [Marqeta MCP Server](https://www.marqeta.com/blog/bringing-agentic-payments-to-life-with-marqetas-mcp-server)
- [CardForAgent](https://cardforagent.com/)
- [Top 10 Virtual Card Issuing APIs 2026](https://apidog.com/blog/top-10-virtual-card-issuing-apis/)

### Part 3: Agent Payment Infrastructure
- [Visa Intelligent Commerce Developer](https://developer.visa.com/use-cases/visa-intelligent-commerce-for-agents)
- [Visa Partners Complete Secure AI Transactions](https://corporate.visa.com/en/sites/visa-perspectives/newsroom/visa-partners-complete-secure-agentic-transactions.html)
- [Mastercard Agent Pay](https://www.mastercard.com/us/en/business/artificial-intelligence/mastercard-agent-pay.html)
- [Stripe Shared Payment Tokens](https://docs.stripe.com/agentic-commerce/concepts/shared-payment-tokens)
- [Stripe Agentic Commerce](https://docs.stripe.com/agentic-commerce)
- [Stripe Machine Payments Protocol](https://stripe.com/blog/machine-payments-protocol)
- [Agent Card Payments Compared](https://www.crossmint.com/learn/agent-card-payments-compared)
- [Privacy.com AI Agent Payment Solutions Compared](https://www.privacy.com/blog/payment-solutions-ai-agents-2026-compared)
- [Crossmint Agentic Payments](https://www.crossmint.com/solutions/agentic-payments)

### Part 4: Duffel Booking & Payment
- [Duffel Hold Orders and Pay Later](https://duffel.com/docs/guides/holding-orders-and-paying-later)
- [Duffel Collecting Customer Card Payments](https://duffel.com/docs/guides/collecting-customer-card-payments)
- [Duffel Links Documentation](https://duffel.com/docs/guides/duffel-links)
- [Duffel Payments](https://duffel.com/payments)
- [Duffel Pricing](https://duffel.com/pricing)
- [DOT 24-Hour Reservation Guidance](https://www.transportation.gov/airconsumer/notice-24hour-reservation)

### Part 5: Agentic Commerce Landscape
- [Agentic Payments Rewriting Spend Management](https://www.apideck.com/blog/agentic-payments-spend-management-ai-agents)
- [AI Agent Payments Landscape 2026](https://www.useproxy.ai/blog/ai-agent-payments-landscape-2026)
- [AI Agents Now Have Their Own Credit Cards](https://blockeden.xyz/blog/2026/03/16/crossmint-ai-agent-virtual-cards-autonomous-payments-kya-stripe-for-agents/)