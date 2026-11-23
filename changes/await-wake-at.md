An await with a wake_at now waits for that time: it isn't checked before then, and it's checked once, right away, when the time comes. Until now only its cadence decided when it was checked.
