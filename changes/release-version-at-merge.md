Pull requests no longer bump the version or edit changelog.json, so merging one no longer makes every other open pull request conflict. Each one adds a change note under changes/ instead, and the release job on main gives every landed change the next 0.1.0-alpha number, writes it into the package, the lockfiles, the wrapper and the Sanctuary deploy files, and adds the notes to the published changelog. A branch that still carries an old-style bump runs `npm run release:drop-bump`.

When two releases publish out of order, the earlier one no longer moves npm's `latest` tag back.
