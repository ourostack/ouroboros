The container image's changelog step now waits out a 404 on the exact npm tarball of the version being released, as it already does for ETARGET, instead of failing the container publish at once.
