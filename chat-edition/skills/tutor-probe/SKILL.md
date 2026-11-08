---
name: tutor-probe
description: Feasibility check for the tutor's claude.ai chat edition. Use only when the user asks to run the tutor probe, test the tutor setup, or check whether the tutor works here. Runs a diagnostic script and a save-back test, then reports the results as a table.
---

# Tutor probe

This checks whether the tutor's chat edition can work in this Project on this plan.
Report findings honestly: a failure here is useful information, not something to
work around.

## 1. Run the script

Find this skill's folder (`find / -name probe.mjs -path "*tutor-probe*" 2>/dev/null | head -1`)
and run `node <that folder>/probe.mjs`. If code execution isn't available at all,
say so. That's the most important finding, so skip to step 3.

## 2. Save-back test

Try to **add a new file to this Project's files** named `probe-check.md`,
containing one line: `probe wrote this on <today's date and time>`. Use whatever
ability you have to update this Project's files. Don't touch any other file.

Then say exactly what happened: whether it worked, which tool or method you used,
or why you couldn't. If it worked, tell the user to check it in a **new chat** in
this Project by asking: *"What does probe-check.md in this project say?"* That's the
real test: the file has to persist into a fresh chat. Once it's checked, they can
delete it.

## 3. Report

End with one table, one row per check: **Check · Result · Detail**. Include:

- every PASS / FAIL / INFO line from the script
- the save-back test
- which model this chat is using
- whether this chat could see the Project's files in context (not just in code)

Then add two plain sentences: does the chat edition look workable here, and what
blocked it if not.
