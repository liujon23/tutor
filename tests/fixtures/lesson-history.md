# Lesson History

<!-- Reverse-chronological log — newest entry first. One entry per lesson.
     Archival: only the last few entries are loaded into a session packet.
     The long-lived "what's settled" signal lives in profile.md → Settled questions. -->

## Lesson 3 — 2026-07-10
**Lane / Unit / Topic:** AI / Neural Network Foundations Refresher / Backpropagation Refresher
**What happened:** Default lane mix (no override); AI lane, mid-unit, backprop was the queued
topic. Ran it as a review pass: mostly check-questions with light scaffolding removed a step at a
time. Arc: motivation (all weight-gradients in ~one backward sweep, not one pass per weight) → a
scalar warm-up → the delta as the quantity carried backward, with each weight's gradient equal to
incoming delta times local input → the efficiency punchline (compute each delta once per node,
reuse across all incoming weights). Closed by naming — but not opening — the matrix-form backward
pass (weight-matrix transpose) as the one genuinely new gear for a future session.
**Performance sketch:** Strong, as expected for review. One slip on a sign early in the scalar
warm-up, self-corrected on a single nudge. Reconstructed the delta-chain factoring and the
once-per-node reuse cleanly under light prompting. Owns the conceptual core; the matrix-calculus
formalization is the only un-exercised piece, deliberately deferred.
**Sources used:** None named beyond standard backprop framing.
**Feedback captured:** Probing/recall structure was good for a review session; more cold-start
recall (answer before being shown) over scaffolded reconstruction was requested for future review
sessions.
**Asked about:** whether the tight, probe-don't-lecture mode fit a short review session (it did).
Did not re-ask depth/pace or history-weaving — both settled.

## Lesson 2 — 2026-06-15
**Lane / Unit / Topic:** AI / Neural Network Foundations Refresher / Loss Functions and Optimization
**What happened:** Quick tangent into gradient descent intuition before time ran out — cross-entropy,
MSE, SGD, and Adam were all named but not consolidated into a working mental model. Flagged as a
topic to revisit properly rather than pushed through under time pressure.
**Performance sketch:** Mixed — engaged well with the intuition but the session ended before any of
it was checked for retention. Graded shaky rather than comfortable; worth a full pass later.
**Sources used:** None named.
**Feedback captured:** Preferred stopping cleanly over rushing the close; confirmed the "call it
anytime" stopping preference in practice.
**Asked about:** whether to push through to a stopping point or end early (ended early, by request).

## Lesson 1 — 2026-06-01
**Lane / Unit / Topic:** AI / Neural Network Foundations Refresher / Activation Functions and Non-Linearity
**What happened:** Worked through why stacking linear layers collapses to a single linear map
(predicted correctly and unprompted), then established that the activation's real job is injecting
non-linearity — the entire source of a network's expressivity. Built the universal-approximation
intuition via summing ReLU "hinges," then toured the activation zoo (sigmoid/tanh saturation →
vanishing gradients; ReLU keeps gradients alive but can die; leaky/GELU patch the negative region).
Corrected a prior framing of activations as regularizing outputs.
**Performance sketch:** Strong. Reached the linear-collapse result independently, extended hints
well, and cleanly diagnosed the closing practice question as testing an already-demonstrated point.
Corrected mental model landed solidly — graded comfortable.
**Sources used:** Universal Approximation Theorem (Cybenko 1989, Hornik 1991), named in lesson.
**Feedback captured:** Depth and pace felt right. History tidbits were a highlight. Practice question
was too easy — it re-tested the lesson's entry point rather than reaching past it.
**Asked about:** overall feel/depth/pace, and why the practice question fell flat.
