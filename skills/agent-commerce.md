# Agent Commerce Skill

How to book, purchase, and pay for things on behalf of humans.

## Three Patterns

### Pattern A: API (Structured, Preferred)

For services with direct API access: Duffel flights, LiteAPI hotels.

1. Search using the API tool (`flight_search`, LiteAPI MCP)
2. Present options to the human with prices and details
3. Human approves a specific option and price
4. Book using the API tool with passenger data from `user_profile_get`
5. Create a single-use virtual card via `stripe_create_card`
6. Complete payment through the API
7. Deactivate the card via `stripe_deactivate_card`
8. Confirm booking to the human

**Key tools**: `flight_search`, `flight_book`, `flight_cancel`, `user_profile_get`, `user_profile_store`, `stripe_create_card`, `stripe_deactivate_card`, `stripe_list_cards`

### Pattern B: Browser (Best-Effort)

For sites without API access, use browser automation via Playwright MCP.

1. Navigate to the booking site
2. Search for the requested service
3. Fill forms using data from `user_profile_get`
4. Use a virtual card from `stripe_create_card` for payment
5. If blocked by anti-bot measures, fall back to Pattern C
6. Complete and confirm the booking

**Limitations**: Browser automation is fragile. Sites may block, layouts change, CAPTCHAs appear. Always have Pattern C as fallback.

### Pattern C: Link-Only (Primary for Hostile Sites)

For sites that block automation or require complex human interaction.

1. Research the best options using browser tools or API tools
2. Prepare a curated link with pre-filled parameters where possible
3. Send the link to the human with a summary of what to book
4. Human completes the booking in their own browser

**When to use**: Always use Pattern C as the primary approach for sites known to block automation (most airline direct sites, hotel chains, rental car sites). Pattern B is best-effort, not reliable.

## Payment autonomy Levels

- **Level 0**: No autonomous payments. Agent researches, human pays manually.
- **Level 1**: Agent creates virtual cards, human approves each transaction explicitly.
- **Level 2**: Agent can book pre-approved items (within budget, approved categories) without per-transaction approval.
- **Level 3**: Full delegation with spending limits. Agent manages a budget and books as needed.

Default is Level 1. Level changes require explicit human approval.

## Error Handling

### Price Change Guard
Before completing a booking, verify the final price matches the approved price within 5%. If the price changed more than 5%, stop and report to the human. Never pay a price the human didn't approve.

### Partial Failure Reporting
When booking involves multiple services (e.g., flight + hotel), each service may succeed or fail independently — this is a partial failure scenario. Report the status of each service separately. **Never auto-cancel a successful booking because a related booking failed.** Let the human decide.

Example: "Flight SFO-JFK booked (confirmation: ABC123). Hotel booking failed: no availability for those dates. Would you like me to search for alternative hotels?"

### Refund Flow
If a booking fails after card creation:
1. Deactivate the virtual card immediately
2. Report the failure to the human
3. If a charge was made, note it for the human to follow up with the provider

## CAPTCHA Handling

When a CAPTCHA appears during browser automation (Pattern B):
1. Take a screenshot and send it to the human
2. Explain what page you're on and what you were trying to do
3. Ask the human to solve the CAPTCHA in their own browser
4. Switch to Pattern C (link-only) for this transaction

Never attempt to solve CAPTCHAs programmatically.

## Card Number Isolation

Card numbers must NEVER appear in:
- Tool return values shown to the model
- Nerves events or logs
- Chat messages to the human
- Any stored state or written notes

The only place card numbers exist is inside the Stripe client's internal payment flow functions, scoped to a single function call. The model only ever sees card IDs and last-4 digits.

## Profile Data Usage

Access profile data only when needed for the current transaction:
- `user_profile_get` to retrieve specific fields (never dump full profile)
- Passport data only for international bookings
- Loyalty program numbers only when booking with that program
- Emergency contact only when the booking service requires it

## Self-Test

Before first use, run the commerce self-test to verify all services are configured:
- Stripe: creates and deactivates a test virtual card
- Duffel: runs a test flight search
- LiteAPI: verifies API key in vault

Report results to the human with actionable next steps for any failures.
