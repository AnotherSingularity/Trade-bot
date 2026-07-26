# Runbook 26 — Code-freeze change control

## Trigger
Any proposed change to the code-freeze surface after the Phase 3B
manifest is issued.

## Symptoms
- A pull request is opened against the frozen branch.
- The code-freeze manifest's `commit` field would change.

## Immediate containment
- Do NOT merge the pull request without documentation ownership sign-off.

## Diagnostic commands
```
cat phase3b_audit/reports/code_freeze_manifest.json | jq '.commit'
git log -1 --format=%H
```

## Recovery procedure
1. Classify the proposed change:
   - **Documentation-only** (comments, markdown, runbooks) → allowed;
     re-run the manifest generator to update `createdAt` and hashes.
   - **Non-doc code change** → NOT allowed. The manifest is
     invalidated. Follow the correction protocol below.
2. Correction protocol:
   a. Open a Phase 3B-FIX branch from the frozen commit.
   b. Apply the correction as an additive commit.
   c. Rerun the full Phase 3B audit + all §Q certification tests.
   d. Regenerate the code-freeze manifest. Its `commit` field is
      the new commit; the old manifest is retained in git history
      but marked superseded.
   e. Push the new commit and update the release manifest reference.

## Verification
- New manifest passes every §Q test.
- Old manifest is preserved and clearly labeled `superseded_by=<sha>`.

## Escalation
- Any non-doc change is a signal to escalate to release owner.

## Data preservation
- Never rewrite git history on the frozen branch.

## Safety implications
- The freeze protects safe flags. Any change to safe-flag policy is
  an unconditional escalation.
