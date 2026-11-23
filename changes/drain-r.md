`ouro up` now says why an update did not install ("could not install X: ..."), instead of "update check unavailable", and says when npm lists a release but is not serving its tarball yet.
The unattended updater treats that not-served-yet answer (ETARGET, or a 404 on the release's tarball) as a wait for the next pass, not an install failure, and does not count it as a failed attempt.
