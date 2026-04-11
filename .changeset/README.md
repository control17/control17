# Changesets

Add a changeset for every user-visible change:

```bash
pnpm changeset
```

Select the packages, the bump type (patch/minor/major), and write a summary.
Changesets are accumulated until a release PR is ready, at which point
`pnpm release` publishes to npm and cuts a changelog entry.

See https://github.com/changesets/changesets for details.
