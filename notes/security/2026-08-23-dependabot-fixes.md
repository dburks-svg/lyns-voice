# Security fixes: Dependabot alerts resolved (2026-08-23)

Session record of the vulnerability remediation on the LYNS Voice repository
(dburks-svg/lyns-voice), commit 983c996 on master.

## Alerts fixed by dependency bumps (npm, package-lock.json)

All three were dev-scope transitive dependencies. Fixed by bumping the lockfile
with `npm update postcss brace-expansion`; `npm audit` clean afterward.

- **postcss** bumped 8.5.15 -> 8.5.26. Fixes GHSA-r28c-9q8g-f849 (high): path
  traversal in previous-source-map auto-loading (`sourceMappingURL`) leading to
  arbitrary `.map` file disclosure. Also fixes GHSA-fxqj-rqcc-2cmp (medium),
  the incomplete-fix follow-up to the same issue. postcss is a transitive dep
  of vite.
- **brace-expansion** bumped 5.0.6 -> 5.0.9. Fixes GHSA-3jxr-9vmj-r5cp (high):
  denial of service via exponential-time expansion of consecutive
  non-expanding `{}` groups. Transitive dep of eslint via minimatch.

## Alert dismissed with rationale (cargo, src-tauri/Cargo.lock)

- **glib 0.18.5** (medium): unsoundness in `Iterator` and
  `DoubleEndedIterator` impls for `glib::VariantStrIter`, patched in glib
  0.20.0. Dismissed as "not used" because:
  - glib is pinned by the gtk 0.18 stack that Tauri v2 itself requires
    (gtk, tao, wry, webkit2gtk); no patched upgrade path exists until Tauri
    migrates to gtk-rs 0.20.
  - glib is a Linux-target-only dependency; LYNS Voice ships Windows-only, so
    glib is never compiled into the released binary.
  - The advisory is a memory-unsoundness in an iterator impl, not a remotely
    reachable vulnerability.
  - Revisit on the next Tauri major or minor bump.

## Process notes

- Pre-ship gate ran before commit: lint clean, typecheck clean, 305/305 unit
  tests passing.
- CI on the pushed commit: all three jobs green (rust, build, security),
  including npm audit, cargo audit, and gitleaks steps.
- The two stale Dependabot PRs (#6 brace-expansion, #7 postcss) were closed as
  superseded and their branches deleted.
- Security tab ended the session with zero open alerts.
