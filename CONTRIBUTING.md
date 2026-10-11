# Contributing

Thank you for improving Codex Bridge. Keep changes focused, explain the user or
operator impact, and include tests when observable behavior changes.

## Development checks

Use the repository-pinned Node.js and Yarn versions. Before opening a change,
run the checks relevant to it:

```bash
corepack yarn check
corepack yarn lint
corepack yarn test
corepack yarn build
```

Protocol compatibility changes should also run:

```bash
corepack yarn verify:codex --scenario protocol --json
```

Do not commit credentials, local runtime data, generated build output, or
private environment files.

## Contribution license

By submitting a contribution to this repository, you agree that it is licensed
under the repository's [MIT License](LICENSE). You represent that you have the
right to submit the contribution under those terms.

Third-party code, assets, or generated material must retain their required
copyright and license notices. Call out any non-MIT material in the change so
its redistribution requirements can be reviewed.
