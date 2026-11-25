Test-only follow-up to the SIP stop-at-configuration voice test: it now holds only the call's bootstrap deadline timer (not every 250 ms timer) and cancels it on cleanup. No change to call behaviour.
