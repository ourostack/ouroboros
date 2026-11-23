# Change notes

Every pull request that changes something a person would notice adds one new file here, `changes/<short-name>.md`,
saying what changed for the people who use it. Each paragraph or `- ` bullet becomes one line of the release's
changelog entry; `#` heading lines are skipped.

Don't bump the version or edit `changelog.json` in a pull request. When the change lands on `main`, the release job
gives it the next version and adds its notes to `changelog.json` in the published package
(`scripts/release-version.cjs`, described in `docs/versioning-strategy.md`). `npm run release:preflight` checks that a
note is here.

Notes stay here after release: the release job reads them from main's history every time, so every published
changelog has every entry. Edit an old note only to fix a typo; a release counts only the notes its own commit added.
