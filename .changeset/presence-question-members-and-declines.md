---
"@azx/ribo-extractor-systemone": patch
---

**`systemOnePresencePhase` asks a question a model can answer.** Two changes to each leaf's
presence question, each fixing a silent loss measured in spike 0012:

- **An enum leaf's question states its members.** The bare wire path (`"dhw.dhwType2"`) names
  nothing a model can match against speech. Every value presence dropped below the threshold
  cleared it once the members were stated (21 of 21 on Microsoft-Decision-1, 13 of 13 on Jev).
  The lookup steps through a collection's element schema, so collection leaves get their members
  too.
- **A stated decline counts as discussed**, including one about a set of fields ("didn't do any of
  the tests"). The old question said "a field merely implied is no", so a blanket "no safety
  tests" scored every test absent. The fill was never asked, and the stated "Not Tested" came
  back null. Health-matrix accuracy behind `presenceNarrowedExtractor` went from 87% to 98%, at
  70–80% more fill input tokens, because presence now says yes more often.

The answer is still thresholded the same way, and the default threshold is unchanged.
