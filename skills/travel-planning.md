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
- Search via `ouro mcp call duffel search_flights`
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
- Use Expedia MCP when available (`ouro mcp call expedia search_hotels`)
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
- Use `vault_get` to retrieve payment credentials (never expose raw values)
- Use `vault_get` for loyalty program numbers
- Use browser-navigation skill form patterns for entering credentials
- The credential gateway ensures secrets never enter model context

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
- `weather_lookup` - Current weather by city or coordinates
- `travel_advisory` - US State Dept advisory by country code
- `geocode_search` - Location/POI search with coordinates
- `vault_get` - Retrieve credentials (payment, loyalty)
- `vault_store` - Store new credentials (family trust required)

### MCP Tools (when configured)
- Browser tools via `@playwright/mcp` - see `browser-navigation` skill
- Duffel flight search (when MCP server available)
- Expedia hotel search (when MCP server available)
- Bitwarden vault management via `@bitwarden/mcp-server`

### Human Confirmation Required For
- Any booking or payment
- Entering personal information
- Agreeing to terms of service
- Creating financial obligations
- Sharing credentials with third parties
