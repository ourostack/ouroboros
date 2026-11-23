Pull requests no longer bump the version or edit changelog.json, so merging one no longer makes every other open pull request conflict. Each one adds a change note under changes/ instead, and the release job on main gives every landed change the next 0.1.0-alpha number, writes it into the package, the lockfiles, the wrapper and the Sanctuary deploy files, and adds the notes to the published changelog. A branch that still carries an old-style bump runs `npm run release:drop-bump`.

A rebase merge of several commits now publishes one release with all of their notes, even when its last commit changes only docs or tests.

Releases publish to npm one at a time, in the order they landed, and a release that finds a later version already on npm's `latest` tag publishes on `alpha` instead of moving `latest` back.

The Unraid template's TemplateURL now points at the newest GitHub release's copy of the template, which carries the newest image's version.

Each release counts from npm's last release, and stops with an error rather than reuse or go back on a version number. When an earlier release never reached npm, the next one's changelog entry carries its notes too, so the changelog never names a version npm doesn't have. The container image now waits for npm's release of the same commit and carries the changelog npm shipped. A manual run of the container workflow now rebuilds only main's head, only when npm published main's version from that commit, and with the changelog npm published. `npm run butler:ship` finds a release's commit from npm, then from its release tag, since no commit subject names the version any more.
