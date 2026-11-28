The Butler's product registration now sets two things in its Telegram chat:
- The owner's name, from the house config.
- The credit top-up reply to "why aren't my shows downloading?". Telegram used to pull these in from Butler code.

On the Butler's image, behaviour is unchanged. An agent with no product now always shows its owner as "Owner", even when its bundle has a `house/house.json`. Telegram's unused `healthSweep` option is removed.
