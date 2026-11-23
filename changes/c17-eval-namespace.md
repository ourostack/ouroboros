An eval run's sandbox no longer shares names with the Butler's tooling, and it stays off the Butler's host.

- Its containers, network and folder are named `eval-sandbox-<run>`, no longer `ouro-eval-<run>`.
- Every container it starts carries the labels `ouro.eval=1` and `ouro.eval.run=<run>`, and so does its network. That includes the fixture, TLS and hand-back helpers. The books oracle's container carries `ouro.eval=1`. CI's clean-up step now removes containers and networks by that label.
- A host that has any of the live Butler's containers (`ouro-butler`, `ouro-butler-staging` or `ouro-butler-rollback`) is refused before anything is created, unless the caller holds a host lock that the Butler's upgrade and rollback honour. Nothing provides that lock yet, so for now eval runs stay off the Butler's host.
- Background: on 2026-11-23 a vanishing eval container broke the Butler's upgrade and its rollback (#1760).
- butler:ship's check for running eval containers (#1764) now finds them by the `ouro.eval=1` label as well as by the old `ouro-eval-` names, so the rename does not hide them from it.
