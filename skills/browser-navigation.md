# Browser Navigation Skill

When to use browser tools and how to navigate effectively.

## When to Use Browser Tools

Use browser navigation when:
- The target site has no API (e.g., Airbnb, VRBO, travel blogs)
- Content is dynamic or requires JavaScript rendering
- Login-required pages need session-based access
- You need to verify visual content (screenshots, layouts)
- Price comparison requires real-time scraping

Do NOT use browser tools when:
- A dedicated API or MCP server exists (prefer `weather_lookup`, Duffel MCP, etc.)
- The data is available via a public JSON endpoint
- The task can be completed with `web_search`

## Stealth Browsing Best Practices

The `@playwright/mcp` server is configured with realistic user-agent and viewport settings. To avoid detection on travel sites:

- **Add delays between navigations**: Wait 2-5 seconds between page loads. Never hammer requests in rapid succession.
- **Vary timing**: Use random delays rather than fixed intervals (e.g., 2-5s, not exactly 3s every time).
- **Avoid predictable patterns**: Don't navigate the same path repeatedly in short succession.
- **Use realistic scroll behavior**: Scroll gradually through pages rather than jumping to specific elements.
- **Respect robots.txt**: Check for rate limits and crawling restrictions.

## Navigation Workflow

Follow this pattern for every page interaction:

1. **Navigate**: Use `browser_navigate` to load the page
2. **Wait**: Allow the page to fully load (use `browser_wait` if needed)
3. **Snapshot**: Take a `browser_snapshot` to understand the page structure
4. **Extract**: Parse the accessibility tree for relevant data
5. **Screenshot** (optional): Use `browser_screenshot` for visual confirmation

## Form Filling Patterns

### Login Flows
1. Navigate to the login page
2. Take a snapshot to identify form fields
3. Use `browser_type` for username/password fields
4. Use `browser_click` to submit
5. Wait for redirect, then verify login succeeded via snapshot
6. NEVER hardcode credentials -- use `credential_get` to retrieve login info

### Sign-up Flows
1. Use `credential_generate_password` to mint a strong password for the target domain
2. Fill the signup form with that password
3. If the site rejects the password policy, generate a new one that matches the site rules
4. Once the site accepts the exact password, call `credential_store` immediately
5. Do not claim a new credential is saved until `credential_store` succeeds

### Search Forms (Hotels, Flights, Rentals)
1. Navigate to the search page
2. Snapshot to identify input fields
3. Fill location/date fields with `browser_type`
4. Select options with `browser_select_option` or `browser_click`
5. Submit the search
6. Wait for results to load (travel sites often have loading animations)
7. Snapshot the results page to extract listings

### Booking Forms
1. **ALWAYS confirm with the user before proceeding to payment**
2. Fill traveler information
3. Use stored credentials for payment (via `credential_get` -- NEVER type raw card numbers)
4. Screenshot the final review page for user confirmation
5. Only click "Book" / "Confirm" after explicit user approval

## Anti-Bot Detection Avoidance

The stealth configuration handles most fingerprinting automatically. Additionally:

- **Don't access detection endpoints**: Avoid URLs containing "captcha", "challenge", "verify"
- **Handle CAPTCHAs**: If you encounter a CAPTCHA, pause and inform the user. Do not attempt automated solving.
- **Rotate viewport sizes occasionally**: Use different viewport sizes across sessions
- **Maintain cookies**: Use persistent `user-data-dir` to appear as a returning user
- **Avoid headless tells**: The user-agent is set to a real browser string

## Travel Site Patterns

### Airbnb / VRBO
1. Search by location + check-in/check-out dates + guests
2. Results load dynamically -- scroll to load more listings
3. Extract: title, price per night, total price, rating, number of reviews
4. For detailed info, click into each listing and snapshot
5. Compare top 3-5 options

### Hotel Sites (Booking.com, Hotels.com)
1. Search by destination + dates + guests + rooms
2. Filter by price range, star rating, amenities
3. Extract: name, price, location, rating, key amenities
4. Check cancellation policies (important for travel planning)

### Flight Comparison
1. Prefer Duffel MCP for flight search (structured API data)
2. Use browser only if Duffel doesn't cover the airline
3. Google Flights is useful for price comparison but requires careful navigation

## Error Handling

- **Page timeouts**: Retry once after 5 seconds. If still failing, inform the user.
- **CAPTCHAs**: Stop and ask the user to solve manually.
- **Stale elements**: Re-snapshot the page and retry the interaction.
- **Blocked/403**: The site may have detected automation. Wait 30 seconds and try with a different approach (e.g., direct URL instead of navigation).
- **Session expired**: Re-login using stored credentials.

## Human Confirmation Gates

**ALWAYS** confirm with the user before:
- Any booking or payment action
- Entering personal information (name, address, phone)
- Agreeing to terms of service
- Subscribing to any service
- Any action that creates a financial obligation
