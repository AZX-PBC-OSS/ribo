---
"@azx/ribo-adapter-snuggpro": minor
---

The four thermostat setpoints are strings, because a range is a legal value

`heatingSetpointHigh`, `heatingSetpointLow`, `coolingSetpointHigh` and
`coolingSetpointLow` were `z.number()`. Snugg Pro's own field description
sanctions a range: "you may enter a range of temperatures for each of the
setpoints separated by a dash (no spaces). For example, you can set the Low temp
setpoint for heating at 60-65 and the High temp setpoint at 68-71." Across 40
staging jobs, 36 of 38 populated records hold one.

As numbers these leaves could only ever emit a single temperature, so an auditor
saying "she keeps it between sixty-six and seventy-four" had to be collapsed or
dropped. They are now strings, with the format in the description because strict
structured output rejects a `pattern` keyword.

This changes the extraction schema: the four leaves are `"type": "string"` in
the JSON Schema sent to the model, and a reviewer edits text rather than a
number. Ground-truth cases that assert a numeric setpoint need re-authoring.
