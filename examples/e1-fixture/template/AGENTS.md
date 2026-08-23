# Controlled fixture rules

- Work only inside this disposable workspace.
- Read `README.md` and the public tests before editing implementation files.
- Do not edit tests or weaken their assertions.
- Use only Node.js built-ins; do not install dependencies or access the network.
- The ledger is single-writer. Do not add locks, services, databases, or broad
  infrastructure.
- The Codex stage creates `src/effect-core.mjs`. The Qoder stage must preserve
  that file byte-for-byte and continue through `src/ledger.mjs` and
  `src/cli.mjs`.
- A newline is the JSONL commit marker. Recover only an incomplete final line;
  never hide corruption in a committed line.
- Do not push, publish, deploy, send messages, or perform any external mutable
  action.
