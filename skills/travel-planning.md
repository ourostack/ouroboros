# Travel Planning Skill

Compose all travel infrastructure to plan and book trips effectively.

## Research Phase

### Destination Research
1. Use `geocode_search` to find candidate destinations and get coordinates
2. Use `weather_lookup` to check climate for travel dates
3. Use `travel_advisory` to check US State Dept safety levels (1-4):
   - Level 1: Exercise Normal Precautions
   - Level 2: Exercise Increased Caution
   - Level 3: Reconsider Travel
   - Level 4: Do Not Travel
4. Use browser tools (see `browser-navigation` skill) for destination reviews, travel blogs, local tips
5. Compare multiple destinations on weather, safety, cost, and flight availability

### Information Gathering Workflow
```
geocode_search -> get coordinates
weather_lookup -> check weather at coordinates
travel_advisory -> check safety level
browser tools -> reviews, local info, pricing
```

## Flight Search

### Using Duffel MCP (when available)
- Search via `duffel_search_flights` tool (first-class MCP tool)
- Provide: origin, destination, dates, passengers, cabin class
- Compare options on price, duration, stops, airline

### Using Browser (fallback)
- Use browser-navigation skill patterns for Google Flights, airline sites
- Add delays between searches to avoid detection

### Comparison Criteria
Present top 3-5 options comparing:
- Total price (including bags, seat selection)
- Duration and number of stops
- Airline and aircraft
- Departure/arrival times
- Cancellation/change policy

## Accommodation Search

### Hotel Search
- Use Expedia MCP when available (`expedia_search_hotels` tool)
- Compare: price per night, total stay cost, location, rating, amenities
- Check cancellation policies (crucial for travel planning)

### Vacation Rentals (Browser-based)
- Use browser-navigation skill for Airbnb/VRBO
- Search by location, dates, guests, budget
- Compare: price, location proximity, reviews, amenities, host rating
- Screenshot listings for user review

### Comparison Criteria
- Price per night and total cost
- Location (distance to key attractions/activities)
- Reviews and ratings
- Amenities (WiFi, kitchen, parking, pool)
- Cancellation flexibility

## Booking Workflow

### Critical Safety Gates
- **ALWAYS confirm with user before any booking action**
- **ALWAYS confirm before entering payment information**
- **ALWAYS confirm before agreeing to terms**
- **Never proceed with a financial commitment without explicit approval**

### Credential Handling

Credentials are managed through the credential access layer, which stores
agent-owned secrets encrypted in the bundle vault. Raw passwords never
enter model context.

- Use `credential_get` to check what credentials exist for a domain (metadata only, never passwords)
- Use `credential_store` to save credentials the agent acquired (e.g., during sign-up for a service)
- The credential gateway automatically injects secrets into API requests via `getRawSecret()`
- Use browser-navigation skill form patterns for entering credentials during interactive sessions

**How credentials work:**
- Agent-owned credentials live in the agent's Bitwarden/Vaultwarden vault
- Travel credentials such as Duffel and Stripe are ordinary vault credential items
- The agent can sign up for services and store its own credentials
- Stored passwords are never returned to the model — only metadata (domain, username, notes)

### Post-Booking
- Save confirmation details (confirmation number, dates, hotel name, airline, booking reference)
- Save to diary/journal for future reference
- Set reminders for check-in windows
- Note cancellation deadlines

## Preference Management

### Storing Preferences
Track and reference these travel preferences:
- Preferred airlines and alliance status
- Preferred hotel chains and loyalty numbers
- Seat preferences (window/aisle, extra legroom)
- Dietary needs for in-flight meals
- Budget ranges (per night for hotels, per flight)
- Must-have amenities (WiFi, gym, pool)

### Using Preferences
- Reference stored preferences when searching
- Apply airline preferences to flight comparisons
- Apply hotel brand preferences to accommodation searches
- Adjust budget ranges based on destination

## Tool Reference

### Native Tools (always available)
- `weather_lookup` - Current weather and daily forecast by city or coordinates (Open-Meteo, zero config)
- `travel_advisory` - US State Dept advisory by country code
- `geocode_search` - Location/POI search with coordinates
- `credential_get` - Check credential metadata for a domain (never returns passwords)
- `credential_store` - Store credentials the agent acquired (family trust, confirmation required)
- `credential_list` - List stored credential domains
- `credential_delete` - Delete stored credentials (family trust, confirmation required)

### MCP Tools (when configured)
- Browser tools via `@playwright/mcp` - see `browser-navigation` skill
- Duffel flight search (when MCP server available)
- Expedia hotel search (when MCP server available)

### Human Confirmation Required For
- Any booking or payment
- Entering personal information
- Agreeing to terms of service
- Creating financial obligations
- Sharing credentials with third parties
