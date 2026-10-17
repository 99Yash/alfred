# Issue tracker

Alfred tracks issues in GitHub Issues on `99Yash/alfred`. There is no other tracker.

## Read

- One issue with its discussion: `gh issue view <n> -R 99Yash/alfred --comments`
- Open issues: `gh issue list -R 99Yash/alfred` (add `--search "<words>"`, `--label <name>`, or `--state all` to narrow or widen)
- A pull request's spec is the issue its commits or body name with `#<n>` or `Closes #<n>`. Read that issue as above.

## Write

- Run `gh auth switch --user 99Yash` immediately before any write (`gh issue create`, `gh issue comment`, `gh pr create`, ...). The machine has more than one account, and `gh auth status` can show `99Yash` while another account makes the call.
- Write one closing keyword for each issue: `Closes #1, Closes #2`. GitHub closes only `#1` from `Closes #1, #2`.
