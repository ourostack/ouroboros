# Change notes

Every pull request that changes something a person would notice adds one new file here, `changes/<branch-name>.md`, named after its branch (with `-` for any `/`) so it never takes another change's name, saying what changed for the people who use it. Each paragraph or `- ` bullet becomes one line of the release's changelog entry; `#` heading lines are skipped.

Don't bump the version or edit `changelog.json` in a pull request. When the change lands on `main`, the release job gives it the next version and adds its notes to `changelog.json` in the published package (`scripts/release-version.cjs`, described in `docs/versioning-strategy.md`). `npm run release:preflight` checks that a note is here, that it is a new file, and that `main` has no note of that name yet. The one exception is a pull request that starts a new release line with `npm run release:bump`: it writes that version's `changelog.json` entry itself and adds no note.

Notes stay here after release: the release job reads them from main's history every time, so every published changelog has every entry. A note is written once: a release uses the note as the commit that added it wrote it, so the preflight refuses an edit to a note that already landed. Removing old notes is fine.
